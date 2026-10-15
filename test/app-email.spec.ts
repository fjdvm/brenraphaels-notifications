import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config';
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
    expect(h.brevoCalls).toHaveLength(0);
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
      'button',
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
  it('sends through Brevo from the App category sender and marks the Email sent', async () => {
    const h = createHarness();
    const { id } = (await (await h.postAppEmail(valid)).json()) as any;
    await h.drainQueue();

    expect(h.brevoCalls).toHaveLength(1);
    const call = h.brevoCalls[0]!;
    expect(call.headers.get('api-key')).toBe('test-key');
    expect(call.body.sender.email).toBe('apps@example.com');
    expect(call.body.to).toEqual([{ email: 'user@example.com' }]);
    expect(call.body.subject).toBe('Welcome aboard');
    expect(call.body.htmlContent).toContain('Your account is ready.');
    expect(call.body.htmlContent).toContain('href="https://hrms.example.com"');

    const record = (await (await h.getEmail(id)).json()) as any;
    expect(record).toMatchObject({
      status: 'sent',
      brevoMessageId: '<brevo-1@smtp-relay.mailin.fr>',
      attempts: 1,
    });
  });

  it('escapes HTML in user-supplied text', async () => {
    const h = createHarness();
    await h.postAppEmail({ ...valid, body: '<script>alert(1)</script>' });
    await h.drainQueue();
    expect(h.brevoCalls[0]!.body.htmlContent).not.toContain('<script>');
  });

  it('marks the Email failed with the reason when Brevo fails', async () => {
    const h = createHarness();
    h.failBrevoWith(401, '{"message":"Key not found"}');
    const { id } = (await (await h.postAppEmail(valid)).json()) as any;
    await h.drainQueue();

    const record = (await (await h.getEmail(id)).json()) as any;
    expect(record.status).toBe('failed');
    expect(record.failureReason).toContain('401');
    expect(record.failureReason).toContain('Key not found');
    expect(record.attempts).toBe(1);
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
    ).toThrow(/BREVO_API_KEY.*DATABASE_URL.*APP_EMAIL_SENDER/s);
  });

  it('is enforced when the Worker handles a request', async () => {
    const h = createHarness({ BREVO_API_KEY: undefined });
    const res = await h.postAppEmail(valid);
    expect(res.status).toBe(500);
  });
});
