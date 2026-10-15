import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { bearerAuth } from 'hono/bearer-auth';
import { ConfigError, parseConfig, type Env } from './config';
import { createDb } from './db/client';
import { createEmail, getEmail, markEnqueueFailed } from './emails/service';
import {
  countUnread,
  createNotifications,
  listNotifications,
  markAllRead,
  markRead,
} from './notifications/service';
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

const requireToken = bearerAuth({
  verifyToken: (token, c) =>
    tokenMatches(
      token,
      parseConfig(c.env as Record<string, unknown>).API_TOKEN,
    ),
});
app.use('/emails/*', requireToken);
app.use('/notifications', requireToken);
app.use('/notifications/*', requireToken);

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

function invalid(c: Context, error: z.ZodError) {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    (errors[issue.path.join('.') || '_'] ??= []).push(issue.message);
  }
  return c.json({ errors }, 400);
}

async function queueEmail(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<EmailRequest>,
  template: string,
) {
  const config = parseConfig(c.env);
  const json = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return invalid(c, parsed.error);
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

app.post('/emails/marketing/list', async (c) => {
  const config = parseConfig(c.env);
  const max = config.MARKETING_MAX_RECIPIENTS;
  const { to: _to, ...single } = marketingEmailRequest.shape;
  const schema = z.object({
    ...single,
    recipients: z
      .array(z.email())
      .min(1, 'Needs at least one recipient')
      .max(max, `Too many recipients: the maximum is ${max}`),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return invalid(c, parsed.error);
  const {
    recipients,
    app: sendingApp,
    subscriberConsent,
    ...values
  } = parsed.data;

  // One Email per distinct address; addresses differing only in case are the same.
  const unique = [
    ...new Map(recipients.map((r) => [r.toLowerCase(), r])).values(),
  ];
  const { db, close } = createDb(config.DATABASE_URL);
  try {
    const emails: Array<{ id: string; recipient: string }> = [];
    for (const recipient of unique) {
      const email = await createEmail(db, config, {
        template: marketing.name,
        recipient,
        sendingApp,
        values,
        subscriberConsent,
      });
      emails.push({ id: email.id, recipient });
    }
    // Each Email is queued on its own; a failure here marks only that Email.
    let queued = 0;
    for (const { id } of emails) {
      try {
        await c.env.EMAIL_QUEUE.send({ emailId: id });
        queued++;
      } catch (err) {
        await markEnqueueFailed(db, id, err);
      }
    }
    return c.json({ queued, emails }, 202);
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

const sendNotificationRequest = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  link: z.url().optional(),
  sendingApp: z.string().min(1),
  targetApp: z.string().min(1),
  userIds: z.array(z.string().min(1)).min(1, 'Needs at least one user id'),
});

const notificationResponse = z.object({
  id: z.uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  sendingApp: z.string(),
  targetApp: z.string(),
  userId: z.string(),
  createdAt: z.date(),
  readAt: z.date().nullable(),
});

const inboxQuery = z.object({
  userId: z.string().min(1),
  app: z.string().min(1),
});

const listQuery = inboxQuery.extend({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

app.post('/notifications', async (c) => {
  const parsed = sendNotificationRequest.safeParse(
    await c.req.json().catch(() => undefined),
  );
  if (!parsed.success) return invalid(c, parsed.error);
  const { db, close } = createDb(parseConfig(c.env).DATABASE_URL);
  try {
    const rows = await createNotifications(db, parsed.data);
    return c.json(
      { notifications: rows.map((r) => notificationResponse.parse(r)) },
      201,
    );
  } finally {
    await close();
  }
});

app.get('/notifications', async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error);
  const { unread, ...q } = parsed.data;
  const { db, close } = createDb(parseConfig(c.env).DATABASE_URL);
  try {
    const page = await listNotifications(db, {
      ...q,
      unreadOnly: unread === 'true',
    });
    if (!page) return c.json({ errors: { cursor: ['Invalid cursor'] } }, 400);
    return c.json({
      notifications: page.items.map((r) => notificationResponse.parse(r)),
      nextCursor: page.nextCursor,
    });
  } finally {
    await close();
  }
});

app.get('/notifications/unread-count', async (c) => {
  const parsed = inboxQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error);
  const { db, close } = createDb(parseConfig(c.env).DATABASE_URL);
  try {
    return c.json({
      unread: await countUnread(db, parsed.data.userId, parsed.data.app),
    });
  } finally {
    await close();
  }
});

app.post('/notifications/read-all', async (c) => {
  const parsed = inboxQuery.safeParse(
    await c.req.json().catch(() => undefined),
  );
  if (!parsed.success) return invalid(c, parsed.error);
  const { db, close } = createDb(parseConfig(c.env).DATABASE_URL);
  try {
    return c.json({
      updated: await markAllRead(db, parsed.data.userId, parsed.data.app),
    });
  } finally {
    await close();
  }
});

app.post('/notifications/:id/read', async (c) => {
  const id = c.req.param('id');
  if (!z.uuid().safeParse(id).success)
    return c.json({ error: 'Not found' }, 404);
  const parsed = inboxQuery.safeParse(
    await c.req.json().catch(() => undefined),
  );
  if (!parsed.success) return invalid(c, parsed.error);
  const { db, close } = createDb(parseConfig(c.env).DATABASE_URL);
  try {
    const found = await markRead(db, id, parsed.data.userId, parsed.data.app);
    if (!found) return c.json({ error: 'Not found' }, 404);
    return c.json({ id, read: true });
  } finally {
    await close();
  }
});
