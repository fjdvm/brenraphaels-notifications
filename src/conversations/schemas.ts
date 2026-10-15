import { z } from 'zod';

export const MAX_TEXT_LENGTH = 2000;

export const role = z.enum(['Customer', 'Staff']);
export type Role = z.infer<typeof role>;

/** Query of the connect route. Declared, not verified, until authentication exists. */
export const connectQuery = z.object({
  userId: z.string().min(1).max(128),
  role,
});

/** Client-to-server: the only frame a connection may send. */
export const sendMessage = z.object({
  type: z.literal('message'),
  /** The sender's own message id, echoed back so each App can match its copy. */
  id: z.string().min(1).max(128),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
});

const person = z.object({ userId: z.string(), role });

/** Server-to-others: a relayed message. */
export const relayedMessage = z.object({
  type: z.literal('message'),
  id: z.string(),
  from: person,
  text: z.string(),
  /** Set by the service, ISO 8601. */
  sentAt: z.iso.datetime(),
});

/** Server-to-sender: how many other connections received the message. */
export const messageDelivered = z.object({
  type: z.literal('message.delivered'),
  id: z.string(),
  delivered: z.number().int().nonnegative(),
});

export const presenceEvent = z.object({
  type: z.literal('presence'),
  event: z.enum(['connected', 'disconnected']),
  ...person.shape,
});

export const conversationError = z.object({
  type: z.literal('error'),
  code: z.enum(['malformed', 'too_long', 'rate_limited']),
  message: z.string(),
  id: z.string().optional(),
});

export const conversationEvent = z.discriminatedUnion('type', [
  relayedMessage,
  messageDelivered,
  presenceEvent,
  conversationError,
]);

export type ConversationEvent = z.infer<typeof conversationEvent>;
