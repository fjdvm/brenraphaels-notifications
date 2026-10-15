import { NotificationHub } from '../src/live/hub';

/**
 * The slice of workerd the hub relies on, in memory: sockets, the Durable
 * Object namespace and its per-name instances. The hub class itself is real.
 */
export class FakeSocket {
  /** Messages the server pushed to this end. */
  received: string[] = [];
  closed = false;
  peer!: FakeSocket;
  send(data: string) {
    if (this.closed) throw new Error('socket closed');
    this.peer.received.push(data);
  }
  close() {
    this.closed = true;
    this.peer.closed = true;
  }
  /** The events received so far, parsed. */
  get events() {
    return this.received.map((m) => JSON.parse(m));
  }
}

class FakeWebSocketPair {
  0 = new FakeSocket();
  1 = new FakeSocket();
  constructor() {
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

(globalThis as any).WebSocketPair = FakeWebSocketPair;
(globalThis as any).WebSocketRequestResponsePair = class {
  constructor(
    public request: string,
    public response: string,
  ) {}
};

export function createHubNamespace() {
  const hubs = new Map<string, NotificationHub>();
  const names: string[] = [];
  const stubFor = (name: string) => {
    let hub = hubs.get(name);
    if (!hub) {
      const sockets: FakeSocket[] = [];
      const ctx = {
        acceptWebSocket: (ws: FakeSocket) => void sockets.push(ws),
        getWebSockets: () => sockets.filter((s) => !s.closed),
        setWebSocketAutoResponse: () => {},
      };
      hub = new NotificationHub(ctx as any, {}, (client) =>
        Object.assign(new Response(null), { webSocket: client }),
      );
      hubs.set(name, hub);
    }
    return {
      fetch: (input: any, init?: any) => hub.fetch(new Request(input, init)),
    };
  };
  return {
    names,
    idFromName: (name: string) => (names.push(name), name),
    get: (id: string) => stubFor(id),
  };
}
