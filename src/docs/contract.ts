import { z } from 'zod';
import type { ZodType } from 'zod';
import { orderConnectQuery, publishOrderEvent } from '../orders/schemas';
import {
  appEmailRequest,
  marketingEmailRequest,
  marketingListRequest,
} from '../emails/schemas';
import {
  inboxQuery,
  lookupQuery,
  listQuery,
  notificationResponse,
  sendNotificationRequest,
} from '../notifications/schemas';

export interface RouteSpec {
  method: 'get' | 'post';
  path: string;
  summary: string;
  /** `token` routes need the bearer token; `open` routes need nothing. */
  auth: 'token' | 'open';
  query?: ZodType;
  headers?: ZodType;
  body?: ZodType;
  success: { status: number; description: string; schema?: ZodType };
  /** Statuses beyond the ones every token route can answer (400, 401, 500). */
  errors: number[];
}

const emailQueued = z.object({
  id: z.uuid(),
  status: z.literal('queued'),
});

/**
 * Every route the app serves, with the schemas it validates with. The
 * OpenAPI document is built from this list, and a test fails when the app
 * and the list disagree.
 */
export const routes = {
  health: {
    method: 'get',
    path: '/health',
    summary: 'Platform health probe',
    auth: 'open',
    success: {
      status: 200,
      description: 'The HTTP service is ready.',
      schema: z.object({ status: z.literal('ok') }),
    },
    errors: [],
  },
  sendNotification: {
    method: 'post',
    path: '/notifications',
    summary: 'Send a Notification to one or more users',
    auth: 'token',
    body: sendNotificationRequest,
    success: {
      status: 201,
      description:
        'Stored, then pushed live. `stored` counts Notifications, `connected` counts recipients with an open connection.',
      schema: z.object({
        notifications: z.array(notificationResponse),
        stored: z.number().int(),
        connected: z.number().int(),
      }),
    },
    errors: [],
  },
  listNotifications: {
    method: 'get',
    path: '/notifications',
    summary: "List a user's Notifications, newest first",
    auth: 'token',
    query: listQuery,
    success: {
      status: 200,
      description: 'A page of Notifications and the cursor for the next one.',
      schema: z.object({
        notifications: z.array(notificationResponse),
        nextCursor: z.string().nullable(),
      }),
    },
    errors: [],
  },
  lookupNotification: {
    method: 'get',
    path: '/notifications/lookup',
    summary: 'Find one Notification by id or retry key without paging',
    auth: 'token',
    query: lookupQuery,
    success: {
      status: 200,
      description: 'The matching Notification, or null.',
      schema: z.object({ notification: notificationResponse.nullable() }),
    },
    errors: [],
  },
  unreadCount: {
    method: 'get',
    path: '/notifications/unread-count',
    summary: "Count a user's unread Notifications",
    auth: 'token',
    query: inboxQuery,
    success: {
      status: 200,
      description: 'The unread count.',
      schema: z.object({ unread: z.number().int() }),
    },
    errors: [],
  },
  markAllRead: {
    method: 'post',
    path: '/notifications/read-all',
    summary: "Mark all of a user's Notifications read",
    auth: 'token',
    body: inboxQuery,
    success: {
      status: 200,
      description: 'How many changed. Open connections are told.',
      schema: z.object({ updated: z.number().int() }),
    },
    errors: [],
  },
  markRead: {
    method: 'post',
    path: '/notifications/:id/read',
    summary: 'Mark one Notification read',
    auth: 'token',
    body: inboxQuery,
    success: {
      status: 200,
      description: 'The Notification is read. Marking it again is harmless.',
      schema: z.object({ id: z.uuid(), read: z.literal(true) }),
    },
    errors: [404],
  },
  sendAppEmail: {
    method: 'post',
    path: '/emails/app',
    summary: 'Queue an App email now or at sendAt',
    auth: 'token',
    headers: z.object({
      'Idempotency-Key': z.string().trim().min(1).max(255).optional(),
    }),
    body: appEmailRequest,
    success: {
      status: 202,
      description:
        'Queued for delivery. Optional Idempotency-Key reuses the original Email, scoped to App and recipient.',
      schema: emailQueued.extend({
        status: z.enum(['queued', 'sent', 'failed']),
      }),
    },
    errors: [],
  },
  sendMarketingEmail: {
    method: 'post',
    path: '/emails/marketing',
    summary: 'Queue a Marketing email to one Subscriber',
    auth: 'token',
    body: marketingEmailRequest,
    success: {
      status: 202,
      description: 'Queued for delivery.',
      schema: emailQueued,
    },
    errors: [],
  },
  sendMarketingEmailList: {
    method: 'post',
    path: '/emails/marketing/list',
    summary: 'Queue a Marketing email to a list of Subscribers',
    auth: 'token',
    body: marketingListRequest(100),
    success: {
      status: 202,
      description:
        'One Email per distinct address. `queued` counts the ones that were queued.',
      schema: z.object({
        queued: z.number().int(),
        emails: z.array(z.object({ id: z.uuid(), recipient: z.string() })),
      }),
    },
    errors: [],
  },
  getEmail: {
    method: 'get',
    path: '/emails/:id',
    summary: 'Look up an Email and its delivery outcome',
    auth: 'token',
    success: {
      status: 200,
      description: 'The stored record of the Email.',
      schema: z.object({
        id: z.uuid(),
        category: z.enum(['app', 'marketing']),
        template: z.string(),
        recipient: z.string(),
        sendingApp: z.string(),
        subscriberConsent: z.boolean().nullable(),
        status: z.enum(['queued', 'sent', 'failed']),
        attempts: z.number().int(),
        messageId: z.string(),
        failureReason: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    },
    errors: [404],
  },
  live: {
    method: 'get',
    path: '/live',
    summary: "Open a WebSocket for a user's live Notifications",
    auth: 'open',
    query: inboxQuery,
    success: { status: 101, description: 'Switching to WebSocket.' },
    errors: [400, 401, 426],
  },
  orderLive: {
    method: 'get',
    path: '/orders/live',
    summary:
      "Open a gateway-only WebSocket for one Customer's Order and Return events",
    auth: 'open',
    query: orderConnectQuery,
    success: {
      status: 101,
      description: 'Switching to WebSocket. Requires X-Gateway-Secret.',
    },
    errors: [400, 401, 426],
  },
  publishOrderEvent: {
    method: 'post',
    path: '/orders/events',
    summary:
      'Relay an Order or Return event to one Customer without storing it',
    auth: 'token',
    body: publishOrderEvent,
    success: {
      status: 200,
      description:
        'Number of connected sockets reached; offline events are dropped.',
      schema: z.object({ connected: z.number().int().nonnegative() }),
    },
    errors: [],
  },
  staffOrderLive: {
    method: 'get',
    path: '/orders/staff/live',
    summary: 'Gateway-only Staff Orders WebSocket (CRMS Caller tickets only)',
    auth: 'open',
    query: orderConnectQuery,
    success: {
      status: 101,
      description:
        'Requires X-Gateway-Secret. Receives payload-free orders.changed signals.',
    },
    errors: [400, 401, 426],
  },
  publishStaffOrdersChanged: {
    method: 'post',
    path: '/orders/changed',
    summary: 'Signal every connected Staff Orders socket without storing data',
    auth: 'token',
    body: z.object({}).strict(),
    success: {
      status: 200,
      description:
        'Number of connected Staff sockets reached; offline signals are dropped.',
      schema: z.object({ connected: z.number().int().nonnegative() }),
    },
    errors: [],
  },
  conversationLive: {
    method: 'get',
    path: '/conversations/:ticketId/live',
    summary: "Open a WebSocket onto a Ticket's Conversation",
    auth: 'open',
    query: z.object({
      userId: z.string().min(1).max(128),
      role: z.enum(['Customer', 'Staff']),
    }),
    success: { status: 101, description: 'Switching to WebSocket.' },
    errors: [400, 401, 404, 426],
  },
  openapi: {
    method: 'get',
    path: '/openapi.json',
    summary: 'This OpenAPI document',
    auth: 'open',
    success: { status: 200, description: 'An OpenAPI 3.1 document.' },
    errors: [],
  },
  docs: {
    method: 'get',
    path: '/docs',
    summary: 'The usage guide',
    auth: 'open',
    success: { status: 200, description: 'An HTML page.' },
    errors: [],
  },
  mcp: {
    method: 'post',
    path: '/mcp',
    summary: 'Remote MCP server for AI agents',
    auth: 'token',
    success: { status: 200, description: 'A JSON-RPC reply.' },
    errors: [],
  },
} satisfies Record<string, RouteSpec>;
