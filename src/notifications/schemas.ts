import { z } from 'zod';

/** A Notification as the REST API returns it and the live socket pushes it. */
export const notificationResponse = z.object({
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

/** Server-to-client events on the live socket. */
export const notificationCreatedEvent = z.object({
  type: z.literal('notification.created'),
  notification: notificationResponse,
});

export const notificationsReadEvent = z.object({
  type: z.literal('notifications.read'),
  ids: z.array(z.uuid()),
});

export const liveEvent = z.discriminatedUnion('type', [
  notificationCreatedEvent,
  notificationsReadEvent,
]);

export type LiveEvent = z.infer<typeof liveEvent>;

/** Request shapes, shared by the routes, the OpenAPI document and the MCP tools. */
export const sendNotificationRequest = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  link: z.url().optional(),
  sendingApp: z.string().min(1),
  targetApp: z.string().min(1),
  userIds: z.array(z.string().min(1)).min(1, 'Needs at least one user id'),
});

export const inboxQuery = z.object({
  userId: z.string().min(1),
  app: z.string().min(1),
});

export const listQuery = inboxQuery.extend({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});
