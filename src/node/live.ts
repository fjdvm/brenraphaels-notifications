import { WebSocket, WebSocketServer } from 'ws';
import { Buffer } from 'node:buffer';
import type { Server } from 'node:http';
import { ConversationRoom } from '../conversations/room';
import type { Env } from '../config';

class Socket {
  private attachment: unknown;
  constructor(readonly connection: WebSocket) {}
  send(data: string) {
    if (this.connection.readyState !== WebSocket.OPEN)
      throw new Error('Socket closed');
    this.connection.send(data);
  }
  close(code: number) {
    this.connection.close(code);
  }
  serializeAttachment(value: unknown) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

/** Node rooms keep the existing namespace keys and relay protocol. No storage or polling. */
export function createLive() {
  const rooms = new Map<string, Set<Socket>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  function broadcast(key: string, data: string) {
    let connected = 0;
    for (const socket of rooms.get(key) ?? []) {
      try {
        socket.send(data);
        connected++;
      } catch {
        /* Closing connection. */
      }
    }
    return connected;
  }
  function namespace(kind: string) {
    return {
      idFromName: (key: string) => key,
      get(key: string) {
        const room = JSON.stringify([kind, key]);
        return {
          async fetch(input: Request | string, init?: RequestInit) {
            const request =
              input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            if (url.pathname === '/push' && request.method === 'POST')
              return Response.json({
                connected: broadcast(room, await request.text()),
              });
            if (url.pathname !== '/connect')
              return new Response('Not found', { status: 404 });
            if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
              return new Response('Expected a WebSocket upgrade', {
                status: 426,
              });
            // Consumed by the HTTP upgrade listener only after Hono's auth and validation.
            return new Response(null, {
              headers: {
                'x-node-room': encodeURIComponent(room),
                'x-node-who': encodeURIComponent(
                  JSON.stringify(Object.fromEntries(url.searchParams)),
                ),
              },
            });
          },
        };
      },
    };
  }
  const bindings = {
    NOTIFICATION_HUB: namespace('notification'),
    ORDER_HUB: namespace('order'),
    CONVERSATION_ROOM: namespace('conversation'),
  } as unknown as Pick<
    Env,
    'NOTIFICATION_HUB' | 'ORDER_HUB' | 'CONVERSATION_ROOM'
  >;

  function attach(
    server: Server,
    fetch: (request: Request) => Promise<Response>,
  ) {
    server.on('upgrade', (request, socket, head) => {
      void (async () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const response = await fetch(
          new Request(new URL(request.url ?? '/', 'http://localhost'), {
            headers,
          }),
        );
        const encodedRoom = response.headers.get('x-node-room');
        if (!response.ok || !encodedRoom) {
          socket.end(
            `HTTP/1.1 ${response.ok ? 400 : response.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
          return;
        }
        const key = decodeURIComponent(encodedRoom);
        const [kind] = JSON.parse(key) as [string];
        const who = JSON.parse(
          decodeURIComponent(response.headers.get('x-node-who')!),
        );
        wss.handleUpgrade(request, socket, head, (connection) => {
          const client = new Socket(connection);
          let members = rooms.get(key);
          if (!members) rooms.set(key, (members = new Set()));
          members.add(client);
          const context = {
            getWebSockets: () => [...members],
          } as unknown as DurableObjectState;
          const conversation =
            kind === 'conversation'
              ? new ConversationRoom(context, {}, undefined, () => {})
              : undefined;
          client.serializeAttachment({
            ...who,
            windowStart: Date.now(),
            count: 0,
          });
          const asWorkerSocket = client as unknown as globalThis.WebSocket;
          if (conversation) {
            for (const other of members) {
              if (other !== client) {
                try {
                  other.send(
                    JSON.stringify({
                      type: 'presence',
                      event: 'connected',
                      ...who,
                    }),
                  );
                } catch {
                  /* Closing. */
                }
              }
            }
          }
          connection.on('message', (data, binary) => {
            const text = Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Buffer.from(
                  data instanceof ArrayBuffer ? data : Buffer.concat(data),
                ).toString('utf8');
            if (!binary && text === 'ping') {
              connection.send('pong');
              return;
            }
            conversation?.webSocketMessage(
              asWorkerSocket,
              binary ? new ArrayBuffer(0) : text,
            );
          });
          connection.on('close', (code) => {
            members.delete(client);
            conversation?.webSocketClose(asWorkerSocket, code);
            if (members.size === 0) rooms.delete(key);
          });
          connection.on('error', (error) => {
            console.error(error);
            connection.close(1011);
          });
        });
      })().catch((error) => {
        console.error(error);
        socket.destroy();
      });
    });
  }
  return {
    bindings,
    attach,
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      rooms.clear();
    },
  };
}
