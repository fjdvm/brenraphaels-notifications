import { eq } from 'drizzle-orm';
import type { Config, EmailJob } from '../config';
import { createDb } from '../db/client';
import { emails } from '../db/schema';
import { deliverEmail } from '../emails/service';
import { RETRY_WINDOW_MS, retryDelaySeconds } from '../emails/retry';

/** Per-Email timers behind the shared enqueue interface; no queue service or polling. */
export function createEmailQueue(config: Config) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const active = new Map<string, Promise<void>>();
  let stopped = false;
  function schedule(emailId: string, delay = 0) {
    if (stopped || timers.has(emailId) || active.has(emailId)) return;
    const due = Date.now() + Math.max(0, delay);
    timers.set(
      emailId,
      setTimeout(
        () => {
          timers.delete(emailId);
          // Node clamps delays beyond 2^31-1 ms to 1 ms. Chain only in-memory
          // timers until due, without a database request at each boundary.
          if (due > Date.now()) {
            schedule(emailId, due - Date.now());
            return;
          }
          const delivery = run(emailId).catch(console.error);
          active.set(emailId, delivery);
        },
        Math.min(2 ** 31 - 1, Math.max(0, delay)),
      ),
    );
  }
  async function run(emailId: string) {
    const { db, close } = createDb(config.DATABASE_URL);
    let retry: number | undefined;
    try {
      const result = await deliverEmail(db, config, emailId);
      retry = result.retryInSeconds;
    } catch (error) {
      console.error(error);
      retry = 30;
    } finally {
      try {
        await close();
      } catch (error) {
        console.error(error);
        retry ??= 30;
      }
      active.delete(emailId);
      if (retry !== undefined) schedule(emailId, retry * 1000);
    }
  }
  return {
    async send(job: EmailJob) {
      schedule(
        job.emailId,
        job.sendAt ? Date.parse(job.sendAt) - Date.now() : 0,
      );
    },
    async recover() {
      const { db, close } = createDb(config.DATABASE_URL);
      try {
        const pending = await db
          .select()
          .from(emails)
          .where(eq(emails.status, 'queued'));
        for (const email of pending) {
          const due =
            email.attempts === 0
              ? (email.sendAt?.getTime() ?? Date.now())
              : Math.min(
                  email.updatedAt.getTime() +
                    retryDelaySeconds(email.attempts) * 1000,
                  Math.max(
                    email.createdAt.getTime(),
                    email.sendAt?.getTime() ?? 0,
                  ) + RETRY_WINDOW_MS,
                );
          schedule(email.id, due - Date.now());
        }
      } finally {
        await close();
      }
    },
    async close() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled(active.values());
    },
  };
}
