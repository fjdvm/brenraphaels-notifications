import { z } from 'zod';
import {
  MAX_TEXT_LENGTH,
  connectQuery,
  sendMessage,
  type ConversationEvent,
  type Role,
} from './schemas';

/** Per-connection limit: this many messages in each window. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10_000;
/** Anything larger than this is rejected before parsing. */
const MAX_FRAME_BYTES = 16 * 1024;

interface Attachment {
  userId: string;
  role: Role;
  windowStart: number;
  count: number;
}

/**
 * One Durable Object per Ticket. It relays each message to the other
 * connections in the room and stores nothing (ADR-0003): no storage, no
 * queue, no history for a connection that arrives later. Per-connection
 * state lives in the socket attachment so it survives hibernation.
 */
export class ConversationRoom {
  constructor(
    private ctx: DurableObjectState,
    _env: unknown,
    // Injectable because a 101 Response only exists inside workerd.
    private upgrade: (client: WebSocket) => Response = (client) =>
      new Response(null, { status: 101, webSocket: client }),
    configurePings: (ctx: DurableObjectState) => void = (ctx) =>
      ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair('ping', 'pong'),
      ),
  ) {
    configurePings(ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/connect') {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const who = connectQuery.parse(Object.fromEntries(url.searchParams));
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      ...who,
      windowStart: Date.now(),
      count: 0,
    } satisfies Attachment);
    this.broadcast(server, {
      type: 'presence',
      event: 'connected',
      ...who,
    });
    return this.upgrade(client);
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const me = ws.deserializeAttachment() as Attachment;
    // Every frame counts, valid or not, so bad frames cannot flood either.
    const now = Date.now();
    if (now - me.windowStart >= RATE_WINDOW_MS) {
      me.windowStart = now;
      me.count = 0;
    }
    me.count++;
    ws.serializeAttachment(me);
    if (me.count > RATE_LIMIT) {
      return reply(ws, 'rate_limited', 'Too many messages');
    }

    if (
      typeof data !== 'string' ||
      new TextEncoder().encode(data).byteLength > MAX_FRAME_BYTES
    ) {
      return reply(ws, 'malformed', 'Expected a JSON text frame under 16 KB');
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return reply(ws, 'malformed', 'Not valid JSON');
    }
    const id = z.object({ id: z.string().max(128) }).safeParse(json);
    const echoId = id.success ? id.data.id : undefined;

    const parsed = sendMessage.safeParse(json);
    if (!parsed.success) {
      const tooLong = parsed.error.issues.some(
        (i) => i.code === 'too_big' && i.path[0] === 'text',
      );
      return tooLong
        ? reply(ws, 'too_long', `Over ${MAX_TEXT_LENGTH} characters`, echoId)
        : reply(ws, 'malformed', 'Not a message', echoId);
    }

    const delivered = this.broadcast(ws, {
      type: 'message',
      id: parsed.data.id,
      from: { userId: me.userId, role: me.role },
      text: parsed.data.text,
      sentAt: new Date(now).toISOString(),
    });
    send(ws, { type: 'message.delivered', id: parsed.data.id, delivered });
  }

  webSocketClose(ws: WebSocket, code: number) {
    const me = ws.deserializeAttachment() as Attachment;
    // 1005/1006 are reserved and cannot be echoed back in a close frame.
    ws.close(code === 1005 || code === 1006 ? 1000 : code);
    this.broadcast(ws, {
      type: 'presence',
      event: 'disconnected',
      userId: me.userId,
      role: me.role,
    });
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws, 1011);
  }

  /** Sends to every connection except `from`; returns how many received it. */
  private broadcast(from: WebSocket, event: ConversationEvent) {
    const text = JSON.stringify(event);
    let reached = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === from) continue;
      try {
        ws.send(text);
        reached++;
      } catch {
        // A socket that is already closing; the runtime drops it.
      }
    }
    return reached;
  }
}

function send(ws: WebSocket, event: ConversationEvent) {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // Closing.
  }
}

function reply(
  ws: WebSocket,
  code: 'malformed' | 'too_long' | 'rate_limited',
  message: string,
  id?: string,
) {
  send(ws, { type: 'error', code, message, ...(id ? { id } : {}) });
}
