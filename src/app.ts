import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { bearerAuth } from 'hono/bearer-auth';
import { ConfigError, parseConfig, type Env } from './config';
import { createDb } from './db/client';
import { createEmail, getEmail, markEnqueueFailed } from './emails/service';
import { appEmail } from './templates/app-email';

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

app.post('/emails/app', async (c) => {
  const config = parseConfig(c.env);
  const json = await c.req.json().catch(() => undefined);
  const parsed = appEmailRequest.safeParse(json);
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      (errors[issue.path.join('.') || '_'] ??= []).push(issue.message);
    }
    return c.json({ errors }, 400);
  }
  const { to, app: sendingApp, ...values } = parsed.data;
  const { db, close } = createDb(config.DATABASE_URL);
  try {
    const email = await createEmail(db, {
      template: appEmail.name,
      recipient: to,
      sendingApp,
      values,
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
});

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
      status: email.status,
      attempts: email.attempts,
      brevoMessageId: email.brevoMessageId,
      failureReason: email.failureReason,
      createdAt: email.createdAt,
      updatedAt: email.updatedAt,
    });
  } finally {
    await close();
  }
});
