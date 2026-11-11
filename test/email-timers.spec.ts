import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config';
import { createEmailQueue } from '../src/node/email-queue';
import { createHarness } from './harness';
import { smtp } from './smtp-stub';

const database = vi.hoisted(() => ({
  queries: [] as string[],
  connections: 0,
}));
// Observe the external database boundary while running real SQL, not a fake DB.
vi.mock('postgres', async (original) => {
  const { default: postgres } = await original<{
    default: typeof import('postgres');
  }>();
  return {
    default: (
      url: string,
      options: import('postgres').Options<Record<string, never>>,
    ) => {
      database.connections++;
      const client = postgres(url, {
        ...options,
        debug: (_connection, query) => database.queries.push(query),
      });
      const end = client.end.bind(client);
      client.end = async (options) => {
        try {
          await end(options);
        } finally {
          database.connections--;
        }
      };
      return client;
    },
  };
});

const DAY = 86_400_000;
const queues: ReturnType<typeof createEmailQueue>[] = [];
beforeEach(() =>
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout'],
    shouldAdvanceTime: true,
    advanceTimeDelta: 1,
  }),
);
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  vi.useRealTimers();
});

function service() {
  const config = parseConfig(createHarness().env);
  const queue = createEmailQueue(config);
  queues.push(queue);
  const http = createHarness({ EMAIL_QUEUE: queue });
  return { ...http, queue };
}

async function status(h: ReturnType<typeof service>, id: string) {
  return (await (await h.getEmail(id)).json()) as {
    status: string;
    attempts: number;
    failureReason: string | null;
    messageId: string;
  };
}

async function eventually(check: () => Promise<void>) {
  const deadline = performance.now() + 3000;
  for (;;) {
    try {
      await check();
      // The HTTP status can become visible before the delivery connection closes.
      // Wait for real I/O to finish before advancing the next Email timer.
      expect(database.connections).toBe(0);
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await pause(10);
    }
  }
}

async function queueOne(h: ReturnType<typeof service>) {
  const response = await h.postAppEmail({
    to: 'user@example.com',
    app: 'HRMS',
    title: 'Hi',
    body: 'Hello',
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { id: string }).id;
}

it('expires a pending Email at 24 hours without another SMTP attempt', async () => {
  const h = service();
  const seed = createHarness();
  const response = await seed.postAppEmail({
    to: 'user@example.com',
    app: 'HRMS',
    title: 'Hi',
    body: 'Hello',
  });
  const { id } = (await response.json()) as { id: string };
  vi.setSystemTime(Date.now() + DAY);
  await h.queue.recover();
  await eventually(async () => {
    expect(await status(h, id)).toMatchObject({
      status: 'failed',
      attempts: 0,
      failureReason: expect.stringMatching(/24.hour/i),
    });
  });
  expect(smtp.calls).toHaveLength(0);
});

it('retries on growing per-Email timers and reuses the queued Message-ID', async () => {
  const h = service();
  h.scriptSmtp(new Error('421 busy'), new Error('421 busy'));
  const id = await queueOne(h);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({
      status: 'queued',
      attempts: 1,
    }),
  );
  await vi.advanceTimersByTimeAsync(29_000);
  expect(smtp.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({
      status: 'queued',
      attempts: 2,
    }),
  );
  await vi.advanceTimersByTimeAsync(59_000);
  expect(smtp.calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({ status: 'sent', attempts: 3 }),
  );
  const email = await status(h, id);
  expect(smtp.calls.map((call) => call.email.messageId)).toEqual([
    email.messageId,
    email.messageId,
    email.messageId,
  ]);
});

it('recovers pending Emails once after restart without duplicate or early attempts', async () => {
  const h = service();
  h.scriptSmtp(new Error('421 busy'));
  const id = await queueOne(h);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({
      status: 'queued',
      attempts: 1,
    }),
  );
  await h.queue.close();
  await vi.advanceTimersByTimeAsync(10_000);

  const restarted = createEmailQueue(parseConfig(h.env));
  queues.push(restarted);
  Object.assign(h.env, { EMAIL_QUEUE: restarted });
  await restarted.recover();
  await restarted.recover();
  await vi.advanceTimersByTimeAsync(19_000);
  expect(smtp.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({ status: 'sent', attempts: 2 }),
  );
  await vi.advanceTimersByTimeAsync(DAY);
  expect(smtp.calls).toHaveLength(2);
});

it('does not duplicate a timer when the same keyed HTTP request is repeated', async () => {
  const h = service();
  h.scriptSmtp(new Error('421 busy'));
  // Reuse precisely the same request key across all submissions.
  const key = crypto.randomUUID();
  const request = () =>
    h.request('/emails/app', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({
        to: 'user@example.com',
        app: 'HRMS',
        title: 'Hi',
        body: 'Hello',
      }),
    });
  const { id } = (await (await request()).json()) as { id: string };
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({
      status: 'queued',
      attempts: 1,
    }),
  );
  expect(await (await request()).json()).toMatchObject({ id });
  await vi.advanceTimersByTimeAsync(29_000);
  expect(smtp.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({ status: 'sent', attempts: 2 }),
  );
  expect(smtp.calls).toHaveLength(2);
});

it('makes no periodic database queries while idle, including after delivery completes', async () => {
  const h = service();
  await h.queue.recover();
  const afterStartup = database.queries.length;
  await vi.advanceTimersByTimeAsync(7 * DAY);
  await pause(30);
  expect(database.queries).toHaveLength(afterStartup);

  const id = await queueOne(h);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({ status: 'sent' }),
  );
  const afterDelivery = database.queries.length;
  await vi.advanceTimersByTimeAsync(7 * DAY);
  await pause(30);
  expect(database.queries).toHaveLength(afterDelivery);
});

it('caps retries at one hour and stops at the deadline without an extra SMTP attempt', async () => {
  const h = service();
  h.failSmtpWith('421 busy');
  const id = await queueOne(h);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({
      status: 'queued',
      attempts: 1,
    }),
  );
  for (const [index, delay] of [
    30, 60, 120, 240, 480, 960, 1920, 3600, 3600,
  ].entries()) {
    await vi.advanceTimersByTimeAsync(delay * 1000);
    await eventually(async () =>
      expect(await status(h, id)).toMatchObject({
        status: 'queued',
        attempts: index + 2,
      }),
    );
  }
  const attempts = smtp.calls.length;
  // Simulate a process suspended until just before the 24-hour deadline.
  vi.setSystemTime(Date.now() + DAY - 60_000);
  await vi.advanceTimersByTimeAsync(3600_000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({
      status: 'failed',
      attempts,
      failureReason: '421 busy',
    }),
  );
  expect(smtp.calls).toHaveLength(attempts);
});

it('schedules the final expiry for the remaining window rather than the full retry delay', async () => {
  const h = service();
  const seed = createHarness();
  const response = await seed.postAppEmail({
    to: 'user@example.com',
    app: 'HRMS',
    title: 'Hi',
    body: 'Hello',
  });
  const { id } = (await response.json()) as { id: string };
  vi.setSystemTime(Date.now() + DAY - 10_000);
  h.failSmtpWith('421 busy');
  await h.queue.recover();
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({
      status: 'queued',
      attempts: 1,
    }),
  );
  await vi.advanceTimersByTimeAsync(9000);
  expect(await status(h, id)).toMatchObject({ status: 'queued', attempts: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureReason: '421 busy',
    }),
  );
  expect(smtp.calls).toHaveLength(1);
});

it('delivers an HRMS App email at sendAt, including beyond the retry window', async () => {
  const h = service();
  const sendAt = new Date(Date.now() + 2 * DAY).toISOString();
  const response = await h.postAppEmail({
    to: 'user@example.com',
    app: 'HRMS',
    title: 'Result',
    body: 'Passed',
    sendAt,
  });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  await vi.advanceTimersByTimeAsync(2 * DAY - 1000);
  await pause(30);
  expect(smtp.calls).toHaveLength(0);
  expect(await status(h, id)).toMatchObject({ status: 'queued', attempts: 0 });
  await vi.advanceTimersByTimeAsync(1000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({ status: 'sent', attempts: 1 }),
  );
});

it('keeps the original scheduled time across keyed retries and restart without idle database work', async () => {
  const h = service();
  const sendAt = new Date(Date.now() + 60_000).toISOString();
  const key = crypto.randomUUID();
  const request = (time: string) =>
    h.request('/emails/app', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({
        to: 'user@example.com',
        app: 'HRMS',
        title: 'Result',
        body: 'Passed',
        sendAt: time,
      }),
    });
  const { id } = (await (await request(sendAt)).json()) as { id: string };
  expect(await (await request(new Date().toISOString())).json()).toMatchObject({
    id,
  });
  await h.queue.close();
  await vi.advanceTimersByTimeAsync(20_000);
  const restarted = createEmailQueue(parseConfig(h.env));
  queues.push(restarted);
  await restarted.recover();
  await restarted.recover();
  const queries = database.queries.length;
  await vi.advanceTimersByTimeAsync(39_000);
  await pause(30);
  expect(database.queries).toHaveLength(queries);
  expect(smtp.calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({ status: 'sent', attempts: 1 }),
  );
  await vi.advanceTimersByTimeAsync(DAY);
  expect(smtp.calls).toHaveLength(1);
});

it('waits beyond the Node timer limit without querying the database early', async () => {
  const h = service();
  const response = await h.postAppEmail({
    to: 'user@example.com',
    app: 'HRMS',
    title: 'Later',
    body: 'Hello',
    sendAt: new Date(Date.now() + 30 * DAY).toISOString(),
  });
  const { id } = (await response.json()) as { id: string };
  const queries = database.queries.length;
  await vi.advanceTimersByTimeAsync(30 * DAY - 1000);
  await pause(30);
  expect(database.queries).toHaveLength(queries);
  expect(smtp.calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({ status: 'sent', attempts: 1 }),
  );
});

it('sends a past sendAt immediately', async () => {
  const h = service();
  const response = await h.postAppEmail({
    to: 'user@example.com',
    app: 'HRMS',
    title: 'Now',
    body: 'Hello',
    sendAt: new Date(Date.now() - DAY).toISOString(),
  });
  const { id } = (await response.json()) as { id: string };
  await eventually(async () =>
    expect(await status(h, id)).toMatchObject({ status: 'sent', attempts: 1 }),
  );
});
