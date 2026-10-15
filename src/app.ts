import { Hono } from 'hono';
import { z } from 'zod';
import { parseConfig, type Env } from './config';
import { createDb } from './db/client';
import { createEmail, getEmail } from './emails/service';
import { appEmail } from './templates/app-email';

const appEmailRequest = z.object({
  to: z.email(),
  app: z.string().min(1),
  ...appEmail.schema.shape,
});

export const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});

app.post('/emails/app', async (c) => {
  const config = parseConfig(c.env);
  const json = await c.req.json().catch(() => undefined);
  const parsed = appEmailRequest.safeParse(json);
  if (!parsed.success) {
    return c.json({ errors: z.flattenError(parsed.error).fieldErrors }, 400);
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
    await c.env.EMAIL_QUEUE.send({ emailId: email.id });
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
