/**
 * One Durable Object per (App, user). Every open WebSocket for that user in
 * that App attaches here, so a push reaches all of their tabs at once.
 * Sockets use the hibernation API: an idle hub is evicted from memory while
 * the connections stay open.
 */
export class NotificationHub {
  constructor(
    private ctx: DurableObjectState,
    _env: unknown,
    // Injectable because a 101 Response only exists inside workerd.
    private upgrade: (client: WebSocket) => Response = (client) =>
      new Response(null, { status: 101, webSocket: client }),
  ) {
    // Answered without waking the object, so keep-alive pings are free.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/push' && request.method === 'POST') {
      return Response.json({ connected: this.broadcast(await request.text()) });
    }
    if (pathname === '/connect') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server!);
      return this.upgrade(client!);
    }
    return new Response('Not found', { status: 404 });
  }

  /** Returns how many connections the message reached. */
  private broadcast(message: string) {
    let reached = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        reached++;
      } catch {
        // A socket that is already closing; the runtime drops it.
      }
    }
    return reached;
  }

  // Clients only listen. Anything they send is ignored.
  webSocketMessage() {}

  webSocketClose(ws: WebSocket, code: number) {
    // 1005/1006 are reserved and cannot be echoed back in a close frame.
    ws.close(code === 1005 || code === 1006 ? 1000 : code);
  }
}
