import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { bearerAuth } from 'hono/bearer-auth';
import { ConfigError, parseConfig, type Env } from './config';
import { createDb } from './db/client';
import { createEmail, getEmail, markEnqueueFailed } from './emails/service';
import { appEmail } from './templates/app-email';
import { marketing } from './templates/marketing';

const appEmailRequest = z.object({
  to: z.email(),
  app: z.string().min(1),
  ...appEmail.schema.shape,
});

function tokenMatches(given: string, expected: string) {
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  let diff = a.byteLength ^ b.byteLength;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ (b[i] ?? 0);
  return diff === 0;
}

export const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  // Names the bad variables only; zod issues never echo the values.
  if (err instanceof ConfigError) return c.json({ error: err.message }, 500);
  return c.json({ error: 'Internal error' }, 500);
});

app.use(
  '/emails/*',
  bearerAuth({
    verifyToken: (token, c) =>
      tokenMatches(
        token,
        parseConfig(c.env as Record<string, unknown>).API_TOKEN,
      ),
  }),
);

const marketingEmailRequest = z.object({
  to: z.email(),
  // A declared check only; real caller identity waits for authentication.
  app: z.literal('CRMS', { error: 'Only CRMS may send Marketing email' }),
  subscriberConsent: z.literal(true, {
    error: 'Must assert that the recipient is a Subscriber',
  }),
  ...marketing.schema.shape,
});

interface EmailRequest {
  to: string;
  app: string;
  subscriberConsent?: boolean;
}

async function queueEmail(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<EmailRequest>,
  template: string,
) {
  const config = parseConfig(c.env);
  const json = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      (errors[issue.path.join('.') || '_'] ??= []).push(issue.message);
    }
    return c.json({ errors }, 400);
  }
  const { to, app: sendingApp, subscriberConsent, ...values } = parsed.data;
  const { db, close } = createDb(config.DATABASE_URL);
  try {
    const email = await createEmail(db, config, {
      template,
      recipient: to,
      sendingApp,
      values,
      subscriberConsent,
    });
    try {
      await c.env.EMAIL_QUEUE.send({ emailId: email.id });
    } catch (err) {
      await markEnqueueFailed(db, email.id, err);
      throw err;
    }
    return c.json({ id: email.id, status: 'queued' }, 202);
  } finally {
    await close();
  }
}

app.post('/emails/app', (c) => queueEmail(c, appEmailRequest, appEmail.name));

app.post('/emails/marketing', (c) =>
  queueEmail(c, marketingEmailRequest, marketing.name),
);

app.get('/emails/:id', async (c) => {
  const config = parseConfig(c.env);
  const id = c.req.param('id');
  if (!z.uuid().safeParse(id).success)
    return c.json({ error: 'Not found' }, 404);
  const { db, close } = createDb(config.DATABASE_URL);
  try {
    const email = await getEmail(db, id);
    if (!email) return c.json({ error: 'Not found' }, 404);
    return c.json({
      id: email.id,
      category: email.category,
      template: email.template,
      recipient: email.recipient,
      sendingApp: email.sendingApp,
      subscriberConsent: email.subscriberConsent,
      status: email.status,
      attempts: email.attempts,
      messageId: email.messageId,
      failureReason: email.failureReason,
      createdAt: email.createdAt,
      updatedAt: email.updatedAt,
    });
  } finally {
    await close();
  }
});
