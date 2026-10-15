import { z } from 'zod';
import type { ZodObject, ZodRawShape } from 'zod';
import {
  appEmailRequest,
  marketingEmailRequest,
  marketingListRequest,
} from '../emails/schemas';
import {
  inboxQuery,
  listQuery,
  sendNotificationRequest,
} from '../notifications/schemas';

type Args = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  input: ZodObject<ZodRawShape>;
  /** The API request this tool stands for. */
  request(args: Args): {
    method: 'GET' | 'POST';
    path: string;
    query?: Args;
    body?: Args;
  };
}

const id = z.uuid().describe('The id returned when it was created.');

/**
 * Each tool is one API route: the same schema validates it and the same
 * handler answers it (the MCP endpoint calls the app in-process), so a
 * tool can never behave differently from the route.
 */
export const tools: Tool[] = [
  {
    name: 'send_notification',
    description:
      'Send a real-time in-app Notification to one or more users of an App. It is stored first, so an offline user still sees it later, then pushed to every open connection. Returns stored (how many Notifications) and connected (how many recipients were online).',
    input: sendNotificationRequest,
    request: (args) => ({ method: 'POST', path: '/notifications', body: args }),
  },
  {
    name: 'list_notifications',
    description:
      "List a user's Notifications in an App, newest first, 20 at a time by default. Pass the returned nextCursor as cursor for the next page. Set unread to 'true' for unread only.",
    input: listQuery,
    request: (args) => ({ method: 'GET', path: '/notifications', query: args }),
  },
  {
    name: 'get_unread_count',
    description: "Count a user's unread Notifications in an App.",
    input: inboxQuery,
    request: (args) => ({
      method: 'GET',
      path: '/notifications/unread-count',
      query: args,
    }),
  },
  {
    name: 'mark_notification_read',
    description:
      "Mark one Notification read. userId and app must be the recipient's, otherwise it is not found.",
    input: z.object({ id, ...inboxQuery.shape }),
    request: ({ id: target, ...body }) => ({
      method: 'POST',
      path: `/notifications/${encodeURIComponent(String(target))}/read`,
      body,
    }),
  },
  {
    name: 'mark_all_notifications_read',
    description: "Mark all of a user's Notifications in an App read.",
    input: inboxQuery,
    request: (args) => ({
      method: 'POST',
      path: '/notifications/read-all',
      body: args,
    }),
  },
  {
    name: 'send_app_email',
    description:
      'Queue a system Email built from the generic App template: a title, body text and an optional button. Not for verification or password reset. Returns an id; use get_email to see the outcome.',
    input: appEmailRequest,
    request: (args) => ({ method: 'POST', path: '/emails/app', body: args }),
  },
  {
    name: 'send_marketing_email',
    description:
      'Queue a Marketing email to one Subscriber. Only CRMS may send it (app must be "CRMS") and subscriberConsent must be true. Returns an id.',
    input: marketingEmailRequest,
    request: (args) => ({
      method: 'POST',
      path: '/emails/marketing',
      body: args,
    }),
  },
  {
    name: 'send_marketing_email_list',
    description:
      'Queue the same Marketing email to a list of Subscribers (100 at most by default). Duplicate addresses are sent once. Only CRMS may send it and subscriberConsent must be true.',
    input: marketingListRequest(100),
    request: (args) => ({
      method: 'POST',
      path: '/emails/marketing/list',
      body: args,
    }),
  },
  {
    name: 'get_email',
    description:
      'Look up an Email: its status (queued, sent or failed), attempt count and last failure reason.',
    input: z.object({ id }),
    request: ({ id: target }) => ({
      method: 'GET',
      path: `/emails/${encodeURIComponent(String(target))}`,
    }),
  },
];
