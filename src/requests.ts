import { z } from 'zod';
import { appEmail } from './templates/app-email';
import { marketing } from './templates/marketing';

/** Request shapes shared by the routes, the OpenAPI document and the MCP tools. */

export const appEmailRequest = z.object({
  to: z.email(),
  app: z.string().min(1),
  ...appEmail.schema.shape,
});

export const marketingEmailRequest = z.object({
  to: z.email(),
  // A declared check only; real caller identity waits for authentication.
  app: z.literal('CRMS', { error: 'Only CRMS may send Marketing email' }),
  subscriberConsent: z.literal(true, {
    error: 'Must assert that the recipient is a Subscriber',
  }),
  ...marketing.schema.shape,
});

export const marketingListRequest = (max: number) => {
  const { to: _to, ...single } = marketingEmailRequest.shape;
  return z.object({
    ...single,
    recipients: z
      .array(z.email())
      .min(1, 'Needs at least one recipient')
      .max(max, `Too many recipients: the maximum is ${max}`),
  });
};

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
