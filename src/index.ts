import { app } from './app';
import { parseConfig, type EmailJob, type Env } from './config';
import { createDb } from './db/client';
import { retryDelaySeconds } from './emails/retry';
import { deliverEmail } from './emails/service';

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<EmailJob>, env: Env) {
    const config = parseConfig(env);
    const { db, close } = createDb(config.DATABASE_URL);
    try {
      for (const message of batch.messages) {
        try {
          const { retryInSeconds } = await deliverEmail(
            db,
            config,
            message.body.emailId,
          );
          if (retryInSeconds) message.retry({ delaySeconds: retryInSeconds });
          else message.ack();
        } catch (err) {
          // Delivery is idempotent (only `queued` Emails are sent), so retrying is safe.
          console.error(err);
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        }
      }
    } finally {
      await close();
    }
  },
} satisfies ExportedHandler<Env, EmailJob>;
