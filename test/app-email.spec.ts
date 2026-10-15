import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config';
import worker from '../src/index';
import { createHarness } from './harness';

afterEach(() => vi.unstubAllGlobals());

const valid = {
  to: 'user@example.com',
  app: 'HRMS',
  title: 'Welcome aboard',
  body: 'Your account is ready.',
  button: { label: 'Open HRMS', link: 'https://hrms.example.com' },
};

describe('requesting an App email', () => {
  it('answers immediately with queued status and an id, and stores an Email record', async () => {
    const h = createHarness();
    const res = await h.postAppEmail(valid);
    expect(res.status).toBe(202);
    const { id, status } = (await res.json()) as any;
    expect(status).toBe('queued');
    expect(id).toEqual(expect.any(String));
    expect(h.queued).toEqual([{ emailId: id }]);

    const record = (await (await h.getEmail(id)).json()) as any;
    expect(record).toMatchObject({
      category: 'app',
      template: 'app-email',
      recipient: 'user@example.com',
      sendingApp: 'HRMS',
      status: 'queued',
      attempts: 0,
    });
    expect(record.createdAt).toBeTruthy();
    expect(record.updatedAt).toBeTruthy();
    expect(h.smtpCalls).toHaveLength(0);
  });

  it('accepts a request without a button', async () => {
    const h = createHarness();
    const { button: _b, ...noButton } = valid;
    expect((await h.postAppEmail(noButton)).status).toBe(202);
  });

  it('rejects invalid requests with field-level messages', async () => {
    const h = createHarness();
    const res = await h.postAppEmail({
      to: 'nope',
      title: '',
      body: 'x',
      button: { label: 'Go', link: 'not a url' },
    });
    expect(res.status).toBe(400);
    const { errors } = (await res.json()) as any;
    expect(Object.keys(errors).sort()).toEqual([
      'app',
      'button.link',
      'title',
      'to',
    ]);
    expect(h.queued).toHaveLength(0);
  });

  it('rejects a body that is not JSON', async () => {
    const h = createHarness();
    const res = await h.postAppEmail(undefined);
    expect(res.status).toBe(400);
  });
});

describe('delivery', () => {
  it('sends over SMTP from the App category sender and marks the Email sent', async () => {
    const h = createHarness();
    const { id } = (await (await h.postAppEmail(valid)).json()) as any;
    await h.drainQueue();

    expect(h.smtpCalls).toHaveLength(1);
    const { options, email } = h.smtpCalls[0]!;
    expect(options).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      startTls: true,
      credentials: { username: 'smtp-user', password: 'smtp-password' },
    });
    expect(email.from).toEqual({
      name: 'Test Sender',
      email: 'apps@example.com',
    });
    expect(email.to).toBe('user@example.com');
    expect(email.subject).toBe('Welcome aboard');
    expect(email.html).toContain('Your account is ready.');
    expect(email.html).toContain('href="https://hrms.example.com"');

    const record = (await (await h.getEmail(id)).json()) as any;
    expect(record).toMatchObject({ status: 'sent', attempts: 1 });
    expect(record.messageId).toBe(email.headers['Message-ID']);
    expect(record.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
  });

  it('escapes HTML in user-supplied text', async () => {
    const h = createHarness();
    await h.postAppEmail({ ...valid, body: '<script>alert(1)</script>' });
    await h.drainQueue();
    expect(h.smtpCalls[0]!.email.html).not.toContain('<script>');
  });

  it('marks the Email failed with the reason when SMTP fails', async () => {
    const h = createHarness();
    h.failSmtpWith('Failed to plain authentication: 535 Authentication failed');
    const { id } = (await (await h.postAppEmail(valid)).json()) as any;
    await h.drainQueue();

    const record = (await (await h.getEmail(id)).json()) as any;
    expect(record.status).toBe('failed');
    expect(record.failureReason).toContain('535 Authentication failed');
    expect(record.messageId).toBeNull();
    expect(record.attempts).toBe(1);
  });
});

describe('authentication', () => {
  it('rejects requests without the API token', async () => {
    const h = createHarness();
    const noAuth = await h.request(
      '/emails/app',
      { method: 'POST', body: '{}' },
      false,
    );
    expect(noAuth.status).toBe(401);
    const wrong = await h.request(
      '/emails/x',
      { headers: { authorization: 'Bearer nope' } },
      false,
    );
    expect(wrong.status).toBe(401);
    expect(h.queued).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('retries the queue message when delivery itself throws', async () => {
    const h = createHarness();
    const { id } = (await (await h.postAppEmail(valid)).json()) as any;
    const retry = vi.fn();
    const ack = vi.fn();
    const broken = {
      ...h.env,
      DATABASE_URL: 'postgres://nobody:x@localhost:1/none',
    };
    await worker.queue(
      { messages: [{ body: { emailId: id }, ack, retry }] } as any,
      broken,
    );
    expect(retry).toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('marks the Email failed and answers 500 when it cannot be queued', async () => {
    const h = createHarness({
      EMAIL_QUEUE: {
        send: async () => {
          throw new Error('queue down');
        },
      },
    });
    expect((await h.postAppEmail(valid)).status).toBe(500);
  });

  it('answers 500 when the SMTP port is not a number', async () => {
    const h = createHarness({ SMTP_PORT: 'abc' });
    expect((await h.postAppEmail(valid)).status).toBe(500);
  });
});

describe('reading status', () => {
  it('returns 404 for an unknown or malformed id', async () => {
    const h = createHarness();
    expect(
      (await h.getEmail('00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect((await h.getEmail('nope')).status).toBe(404);
  });
});

describe('configuration', () => {
  it('stops with a clear error naming the missing or malformed values', () => {
    expect(() =>
      parseConfig({ DATABASE_URL: 'not a url', APP_EMAIL_SENDER: 'x' }),
    ).toThrow(/SMTP_HOST.*SMTP_PASSWORD.*DATABASE_URL.*APP_EMAIL_SENDER/s);
  });

  it('is enforced when the Worker handles a request', async () => {
    const h = createHarness({ SMTP_PASSWORD: undefined });
    const res = await h.postAppEmail(valid);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toContain('SMTP_PASSWORD');
  });
});
