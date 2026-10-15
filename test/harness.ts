import type { EmailJob, Env } from '../src/config';
import worker from '../src/index';
import { smtp } from './smtp-stub';

/** The Worker's public surface with SMTP stubbed and the queue captured. */
export function createHarness(
  overrides: Partial<Record<string, unknown>> = {},
) {
  const queued: EmailJob[] = [];
  smtp.reset();

  const env = {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'smtp-user',
    SMTP_PASSWORD: 'smtp-password',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      'postgres://postgres:test@localhost:54329/postgres',
    APP_EMAIL_SENDER: 'apps@example.com',
    APP_EMAIL_SENDER_NAME: 'Test Sender',
    MARKETING_EMAIL_SENDER: 'marketing@example.com',
    MARKETING_EMAIL_SENDER_NAME: 'Test Marketing',
    API_TOKEN: 'test-token-0123456789',
    EMAIL_QUEUE: { send: async (job: EmailJob) => void queued.push(job) },
    ...overrides,
  } as unknown as Env;

  const request = (path: string, init: RequestInit = {}, authed = true) =>
    worker.fetch(
      new Request(`http://worker${path}`, {
        ...init,
        headers: {
          ...(authed ? { authorization: 'Bearer test-token-0123456789' } : {}),
          ...(init.headers as object),
        },
      }) as any,
      env,
      {} as any,
    );

  return {
    env,
    queued,
    smtpCalls: smtp.calls,
    failSmtpWith: (message: string) => {
      smtp.failure = new Error(message);
    },
    /** Queues the outcome of each upcoming send, in order. */
    scriptSmtp: (...steps: typeof smtp.script) =>
      void smtp.script.push(...steps),
    clearSmtpFailure: () => {
      smtp.failure = undefined;
    },
    postAppEmail: (body: unknown) =>
      request('/emails/app', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    postMarketingEmail: (body: unknown) =>
      request('/emails/marketing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    postMarketingList: (body: unknown) =>
      request('/emails/marketing/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    request,
    getEmail: (id: string) => request(`/emails/${id}`),
    /**
     * Runs the queue consumer over everything queued so far. A message the
     * consumer retries is re-queued, and its delay is reported.
     */
    async drainQueue() {
      const jobs = queued.splice(0);
      const retries: Array<{ emailId: string; delaySeconds?: number }> = [];
      const messages = jobs.map((body) => ({
        body,
        attempts: 1,
        ack: () => {},
        retry: (opts?: { delaySeconds?: number }) => {
          retries.push({ emailId: body.emailId, ...opts });
          queued.push(body);
        },
      }));
      await worker.queue({ messages } as any, env);
      return retries;
    },
  };
}
