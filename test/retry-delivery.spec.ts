import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './harness';

const valid = {
  to: 'user@example.com',
  app: 'HRMS',
  title: 'Hi',
  body: 'Hello',
};

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const HOUR = 3600_000;

async function queueOne(h: ReturnType<typeof createHarness>) {
  const { id } = (await (await h.postAppEmail(valid)).json()) as any;
  const status = async () => (await (await h.getEmail(id)).json()) as any;
  return { id, status };
}

describe('temporary failures', () => {
  it('keeps the Email queued, records the reason and attempt, and retries with growing delays', async () => {
    const h = createHarness();
    h.scriptSmtp(
      new Error('Timeout while waiting for smtp server response'),
      new Error('Failed to EHLO. 421 busy'),
    );
    const { status } = await queueOne(h);

    const first = await h.drainQueue();
    expect(first.map((r) => r.delaySeconds)).toEqual([30]);
    expect(await status()).toMatchObject({
      status: 'queued',
      attempts: 1,
      failureReason: 'Timeout while waiting for smtp server response',
    });

    const second = await h.drainQueue();
    expect(second.map((r) => r.delaySeconds)).toEqual([60]);
    expect(await status()).toMatchObject({ status: 'queued', attempts: 2 });

    expect(await h.drainQueue()).toEqual([]);
    expect(await status()).toMatchObject({
      status: 'sent',
      attempts: 3,
      failureReason: null,
    });
  });

  it('fails the Email once 24 hours have passed since queueing', async () => {
    const h = createHarness();
    h.failSmtpWith('Socket timeout!');
    const { status } = await queueOne(h);

    await h.drainQueue();
    advance(24 * HOUR - 10_000);
    const retries = await h.drainQueue();
    expect(await status()).toMatchObject({ status: 'queued' });
    // The last retry is scheduled for the deadline, not past it.
    expect(retries[0]!.delaySeconds).toBe(10);

    advance(10_000);
    expect(await h.drainQueue()).toEqual([]);
    expect(await status()).toMatchObject({
      status: 'failed',
      failureReason: 'Socket timeout!',
      attempts: 3,
    });
  });
});

describe('permanent failures', () => {
  it('fails at once with the relay reason and does not retry', async () => {
    const h = createHarness();
    h.failSmtpWith('Invalid RCPT TO: <a@b.c> 550 no such user');
    const { status } = await queueOne(h);

    expect(await h.drainQueue()).toEqual([]);
    expect(await status()).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureReason: 'Invalid RCPT TO: <a@b.c> 550 no such user',
    });
    expect(h.smtpCalls).toHaveLength(1);
  });
});

describe('no duplicate sends', () => {
  it('reuses one Message-ID across attempts', async () => {
    const h = createHarness();
    h.scriptSmtp(new Error('Socket timeout!'));
    const { status } = await queueOne(h);
    const { messageId } = await status();
    await h.drainQueue();
    await h.drainQueue();
    expect(h.smtpCalls.map((c) => c.email.headers['Message-ID'])).toEqual([
      messageId,
      messageId,
    ]);
  });

  it('marks the Email sent without resending when Brevo already accepted it', async () => {
    const h = createHarness();
    h.scriptSmtp({
      acceptedThen: new Error('Timeout while waiting for smtp server response'),
    });
    const { status } = await queueOne(h);

    expect((await h.drainQueue()).map((r) => r.delaySeconds)).toEqual([30]);
    expect(await h.drainQueue()).toEqual([]);

    expect(h.smtpCalls).toHaveLength(1);
    expect(await status()).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('sends again when Brevo has no record of the earlier attempt', async () => {
    const h = createHarness();
    h.scriptSmtp(new Error('Socket timeout!'));
    const { status } = await queueOne(h);
    await h.drainQueue();
    await h.drainQueue();
    expect(h.smtpCalls).toHaveLength(2);
    expect(await status()).toMatchObject({ status: 'sent', attempts: 2 });
  });
});
