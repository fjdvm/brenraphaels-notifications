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
