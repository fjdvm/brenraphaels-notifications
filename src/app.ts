import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { bearerAuth } from 'hono/bearer-auth';
import { createMiddleware } from 'hono/factory';
import { ConfigError, parseConfig, type Env } from './config';
import { createDb } from './db/client';
import { createEmail, getEmail, markEnqueueFailed } from './emails/service';
import {
  countUnread,
  findNotification,
  createNotifications,
  listNotifications,
  markAllRead,
  markRead,
} from './notifications/service';
import { connectToOrders, publishToOrders } from './orders/relay';
import { orderConnectQuery, publishOrderEvent } from './orders/schemas';
import { connectToRoom } from './conversations/connect';
import { connectToHub, pushToUser } from './live/push';
import guide from './docs/guide.html';
import { buildOpenApiDocument } from './docs/openapi';
import { handleMcp } from './mcp/router';
import { connectQuery } from './conversations/schemas';
import { appEmail } from './templates/app-email';
import { marketing } from './templates/marketing';
import {
  appEmailRequest,
  marketingEmailRequest,
  marketingListRequest,
} from './emails/schemas';
import {
  inboxQuery,
  lookupQuery,
  listQuery,
  notificationResponse,
  sendNotificationRequest,
} from './notifications/schemas';

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
app.use('/mcp', requireToken);

// The live routes take no bearer token (browsers cannot set one on a
// WebSocket). They accept only the gateway, which checks the Ticket is live
// before forwarding, so connecting directly would bypass that check.
const requireGateway = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const secret = parseConfig(c.env).GATEWAY_SECRET;
  const given = c.req.header('x-gateway-secret');
  if (given === undefined || !tokenMatches(given, secret))
    return c.json({ error: 'Unauthorized' }, 401);
  await next();
});
app.use('/live', requireGateway);
app.use('/orders/live', requireGateway);
app.use('/orders/events', requireToken);
app.use('/conversations/:ticketId/live', requireGateway);

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
  const idempotencyKey =
    template === appEmail.name ? c.req.header('idempotency-key') : undefined;
  if (
    idempotencyKey !== undefined &&
    (!idempotencyKey.trim() || idempotencyKey.length > 255)
  ) {
    return c.json(
      { error: 'Idempotency-Key must contain 1–255 characters' },
      400,
    );
  }
  const config = parseConfig(c.env);
  const json = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return invalid(c, parsed.error);
  const { to, app: sendingApp, subscriberConsent, ...values } = parsed.data;
  const { db, close } = createDb(config.DATABASE_URL);
  try {
    const email = await createEmail(db, config, {
      idempotencyKey,
      template,
      recipient: to,
      sendingApp,
      values,
      subscriberConsent,
    });
    try {
      if (email.status === 'queued')
        await c.env.EMAIL_QUEUE.send({ emailId: email.id });
    } catch (err) {
      if (!idempotencyKey) await markEnqueueFailed(db, email.id, err);
      throw err;
    }
    return c.json({ id: email.id, status: email.status }, 202);
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
  const schema = marketingListRequest(config.MARKETING_MAX_RECIPIENTS);
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

app.post('/notifications', async (c) => {
  const parsed = sendNotificationRequest.safeParse(
    await c.req.json().catch(() => undefined),
  );
  if (!parsed.success) return invalid(c, parsed.error);
  const { db, close } = createDb(parseConfig(c.env).DATABASE_URL);
  try {
    const rows = await createNotifications(db, parsed.data);
    const stored = rows.map((r) => notificationResponse.parse(r));
    // Pushed only once stored, so a missed push loses nothing.
    const reached = await Promise.all(
      stored.map((notification) =>
        pushToUser(c.env, notification.targetApp, notification.userId, {
          type: 'notification.created',
          notification,
        }),
      ),
    );
    return c.json(
      {
        notifications: stored,
        stored: stored.length,
        // Recipients with at least one open connection, so it pairs with `stored`.
        connected: reached.filter((sockets) => sockets > 0).length,
      },
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

app.get('/notifications/lookup', async (c) => {
  const parsed = lookupQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error);
  const { db, close } = createDb(parseConfig(c.env).DATABASE_URL);
  try {
    const row = await findNotification(db, parsed.data);
    return c.json({
      notification: row ? notificationResponse.parse(row) : null,
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
    const { userId, app: targetApp } = parsed.data;
    const ids = await markAllRead(db, userId, targetApp);
    if (ids.length > 0)
      await pushToUser(c.env, targetApp, userId, {
        type: 'notifications.read',
        ids,
      });
    return c.json({ updated: ids.length });
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
    const { userId, app: targetApp } = parsed.data;
    const { found, changed } = await markRead(db, id, userId, targetApp);
    if (!found) return c.json({ error: 'Not found' }, 404);
    if (changed)
      await pushToUser(c.env, targetApp, userId, {
        type: 'notifications.read',
        ids: [id],
      });
    return c.json({ id, read: true });
  } finally {
    await close();
  }
});

// Outside the bearer token (see requireGateway). The user id is declared by
// the gateway, not verified here.
app.get('/live', (c) => {
  const parsed = inboxQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error);
  return connectToHub(c.env, parsed.data.app, parsed.data.userId, c.req.raw);
});

// Gateway-only like /live. The Ticket id is
// opaque here: this service knows nothing about Tickets (ADR-0003).
app.get('/conversations/:ticketId/live', (c) => {
  const ticketId = c.req.param('ticketId');
  if (ticketId.length > 128) return c.json({ error: 'Not found' }, 404);
  const parsed = connectQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error);
  return connectToRoom(c.env, ticketId, parsed.data, c.req.raw);
});

// The gateway vouches for this Customer. No history is kept for disconnected browsers.
app.get('/orders/live', (c) => {
  const parsed = orderConnectQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error);
  return connectToOrders(c.env, parsed.data.userId, c.req.raw);
});

app.post('/orders/events', async (c) => {
  const parsed = publishOrderEvent.safeParse(
    await c.req.json().catch(() => undefined),
  );
  if (!parsed.success) return invalid(c, parsed.error);
  return publishToOrders(c.env, parsed.data.customerId, parsed.data.event);
});

// The guide and the OpenAPI document need no token: they describe the API.
const openApiDocument = buildOpenApiDocument();
app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/openapi.json', (c) => c.json(openApiDocument));
app.get('/docs', (c) => c.html(guide));

// Stateless remote MCP server. Each tool calls a route of this app in-process
// with the caller's own token.
app.post('/mcp', (c) =>
  handleMcp(c.req.raw, (request) => app.fetch(request, c.env)),
);
