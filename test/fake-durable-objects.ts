import { OrderHub } from '../src/orders/hub';
import { ConversationRoom } from '../src/conversations/room';
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
  attachment: unknown;
  /** Set on the server end: what the runtime does when the client acts. */
  onClientMessage?: (data: string | ArrayBuffer) => void;
  onClientClose?: () => void;
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  /** Client end: the person types something. */
  say(data: unknown) {
    this.peer.onClientMessage?.(
      typeof data === 'string' || data instanceof ArrayBuffer
        ? data
        : JSON.stringify(data),
    );
  }
  /** Client end: the person closes the tab. */
  leave() {
    this.closed = this.peer.closed = true;
    this.peer.onClientClose?.();
  }
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

/** Generic over the Durable Object class: one instance per name, with fake sockets. */
function createNamespace<T extends NotificationHub | ConversationRoom>(
  make: (ctx: any, upgrade: (client: WebSocket) => Response) => T,
) {
  const objects = new Map<string, T>();
  const names: string[] = [];
  const stubFor = (name: string) => {
    let obj = objects.get(name);
    if (!obj) {
      const sockets: FakeSocket[] = [];
      const ctx = {
        acceptWebSocket: (ws: FakeSocket) => {
          sockets.push(ws);
          const o = obj as any;
          ws.onClientMessage = (data) => o.webSocketMessage?.(ws, data);
          ws.onClientClose = () => o.webSocketClose?.(ws, 1000, '', true);
        },
        getWebSockets: () => sockets.filter((s) => !s.closed),
        setWebSocketAutoResponse: () => {},
      };
      obj = make(ctx, (client) =>
        Object.assign(new Response(null), { webSocket: client }),
      );
      objects.set(name, obj);
    }
    return {
      fetch: (input: any, init?: any) => obj.fetch(new Request(input, init)),
    };
  };
  return {
    names,
    idFromName: (name: string) => (names.push(name), name),
    get: (id: string) => stubFor(id),
  };
}

export const createRoomNamespace = () =>
  createNamespace((ctx, upgrade) => new ConversationRoom(ctx, {}, upgrade));

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

export const createOrderHubNamespace = () =>
  createNamespace((ctx, upgrade) => new OrderHub(ctx, {}, upgrade));
