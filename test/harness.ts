import worker from '../src/index';
import type { EmailJob, Env } from '../src/config';

export interface BrevoCall {
  headers: Headers;
  body: any;
}

/** The Worker's public surface with Brevo stubbed and the queue captured. */
export function createHarness(
  overrides: Partial<Record<string, unknown>> = {},
) {
  const queued: EmailJob[] = [];
  const brevoCalls: BrevoCall[] = [];
  let brevoResponse: () => Response = () =>
    Response.json(
      { messageId: '<brevo-1@smtp-relay.mailin.fr>' },
      { status: 201 },
    );

  const env = {
    BREVO_API_KEY: 'test-key',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      'postgres://postgres:test@localhost:54329/postgres',
    APP_EMAIL_SENDER: 'apps@example.com',
    API_TOKEN: 'test-token-0123456789',
    EMAIL_QUEUE: { send: async (job: EmailJob) => void queued.push(job) },
    ...overrides,
  } as unknown as Env;

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    brevoCalls.push({
      headers: new Headers(init.headers),
      body: JSON.parse(init.body as string),
    });
    return brevoResponse();
  });

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
    brevoCalls,
    failBrevoWith: (status: number, body: string) => {
      brevoResponse = () => new Response(body, { status });
    },
    postAppEmail: (body: unknown) =>
      request('/emails/app', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    request,
    getEmail: (id: string) => request(`/emails/${id}`),
    /** Runs the queue consumer over everything queued so far. */
    async drainQueue() {
      const jobs = queued.splice(0);
      const batch = { messages: jobs.map((body) => ({ body, ack: () => {} })) };
      await worker.queue(batch as any, env);
    },
  };
}
