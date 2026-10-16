import { describe, expect, it } from 'vitest';
import {
  liveEvent,
  notificationCreatedEvent,
} from '../src/notifications/schemas';
import { GATEWAY_SECRET, createHarness } from './harness';

const base = {
  type: 'order.shipped',
  title: 'Order shipped',
  body: 'Your order is on its way.',
  sendingApp: 'POS',
  targetApp: 'Portal',
};

let n = 0;
const fresh = () => `live-${Date.now()}-${n++}`;

function setup() {
  const h = createHarness();
  const send = (userIds: string[], extra: Record<string, unknown> = {}) =>
    h.postJson('/notifications', { ...base, userIds, ...extra });
  return { h, send };
}

describe('connecting', () => {
  it('upgrades a connection for a user and App, without the API token', async () => {
    const { h } = setup();
    const { res, socket } = await h.connect(fresh(), 'Portal');
    expect(res.status).toBe(200); // 101 inside workerd; Node cannot build one
    expect(socket).toBeDefined();
  });

  it('rejects a connect without user and App, and a non-WebSocket request', async () => {
    const { h } = setup();
    expect(
      (
        await h.request(
          '/live',
          { headers: { 'x-gateway-secret': GATEWAY_SECRET } },
          false,
        )
      ).status,
    ).toBe(400);
    const plain = await h.request(
      '/live?userId=u&app=Portal',
      { headers: { 'x-gateway-secret': GATEWAY_SECRET } },
      false,
    );
    expect(plain.status).toBe(426);
  });
});

describe('pushing new Notifications', () => {
  it('reaches a single open connection, after storing', async () => {
    const { h, send } = setup();
    const user = fresh();
    const { socket } = await h.connect(user, 'Portal');

    const res = await send([user]);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ stored: 1, connected: 1 });

    expect(socket.events).toHaveLength(1);
    const event = notificationCreatedEvent.parse({
      ...socket.events[0],
      notification: {
        ...socket.events[0].notification,
        createdAt: new Date(socket.events[0].notification.createdAt),
      },
    });
    expect(event.notification.id).toBe(body.notifications[0].id);

    // Stored, so a later REST list shows what was pushed.
    const list = (await (
      await h.request(`/notifications?userId=${user}&app=Portal`)
    ).json()) as any;
    expect(list.notifications[0].id).toBe(event.notification.id);
  });

  it('reaches every connection the user has open', async () => {
    const { h, send } = setup();
    const user = fresh();
    const a = await h.connect(user, 'Portal');
    const b = await h.connect(user, 'Portal');
    const body = (await (await send([user])).json()) as any;
    // Two tabs, one recipient: counted once.
    expect(body).toMatchObject({ stored: 1, connected: 1 });
    expect(a.socket.events).toHaveLength(1);
    expect(b.socket.events).toEqual(a.socket.events);
  });

  it('keeps the Notification and reports zero connected when nobody is listening', async () => {
    const { h, send } = setup();
    const user = fresh();
    const res = await send([user]);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ stored: 1, connected: 0 });
    const list = (await (
      await h.request(`/notifications?userId=${user}&app=Portal`)
    ).json()) as any;
    expect(list.notifications).toHaveLength(1);
  });

  it('does not count or push to a closed connection', async () => {
    const { h, send } = setup();
    const user = fresh();
    const open = await h.connect(user, 'Portal');
    const gone = await h.connect(user, 'Portal');
    gone.socket.close();
    expect(await (await send([user])).json()).toMatchObject({ connected: 1 });
    expect(open.socket.events).toHaveLength(1);
  });

  it('still stores when the push itself fails', async () => {
    const h = createHarness({
      NOTIFICATION_HUB: {
        idFromName: (x: string) => x,
        get: () => ({
          fetch: async () => {
            throw new Error('hub down');
          },
        }),
      },
    });
    const user = fresh();
    const res = await h.postJson('/notifications', {
      ...base,
      userIds: [user],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ stored: 1, connected: 0 });
  });

  it('delivers to each recipient only their own Notification', async () => {
    const { h, send } = setup();
    const [u1, u2, u3] = [fresh(), fresh(), fresh()];
    const c1 = await h.connect(u1, 'Portal');
    const c2 = await h.connect(u2, 'Portal');
    expect(await (await send([u1, u2, u3])).json()).toMatchObject({
      stored: 3,
      connected: 2,
    });
    expect(c1.socket.events[0].notification.userId).toBe(u1);
    expect(c2.socket.events[0].notification.userId).toBe(u2);
  });
});

describe('isolation', () => {
  it("never delivers another user's or another App's Notifications", async () => {
    const { h, send } = setup();
    const [user, other] = [fresh(), fresh()];
    const mine = await h.connect(user, 'Portal');
    const otherUser = await h.connect(other, 'Portal');
    const otherApp = await h.connect(user, 'CRMS');

    await send([user]);

    expect(mine.socket.events).toHaveLength(1);
    expect(otherUser.socket.events).toHaveLength(0);
    expect(otherApp.socket.events).toHaveLength(0);
  });

  it('keeps names unambiguous between App and user id', async () => {
    const { h, send } = setup();
    const a = await h.connect('b', 'a:');
    const b = await h.connect(':b', 'a');
    await send(['b'], { targetApp: 'a:' });
    expect(a.socket.events).toHaveLength(1);
    expect(b.socket.events).toHaveLength(0);
  });
});

describe('read sync', () => {
  const unreadIds = async (h: ReturnType<typeof setup>['h'], user: string) =>
    (
      (
        (await (
          await h.request(`/notifications?userId=${user}&app=Portal`)
        ).json()) as any
      ).notifications as any[]
    ).map((x) => x.id);

  it('announces one read to every connection of the user', async () => {
    const { h, send } = setup();
    const user = fresh();
    const a = await h.connect(user, 'Portal');
    const b = await h.connect(user, 'Portal');
    await send([user]);
    const [id] = await unreadIds(h, user);

    const res = await h.postJson(`/notifications/${id}/read`, {
      userId: user,
      app: 'Portal',
    });
    expect(res.status).toBe(200);

    for (const { socket } of [a, b]) {
      expect(liveEvent.parse(socket.events[1])).toEqual({
        type: 'notifications.read',
        ids: [id],
      });
    }
  });

  it('announces read-all with the ids that changed', async () => {
    const { h, send } = setup();
    const user = fresh();
    const { socket } = await h.connect(user, 'Portal');
    await send([user]);
    await send([user]);
    const ids = await unreadIds(h, user);

    await h.postJson('/notifications/read-all', {
      userId: user,
      app: 'Portal',
    });

    const event = liveEvent.parse(socket.events[2]);
    expect(event.type).toBe('notifications.read');
    expect(
      (event as any).ids.sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('stays quiet when nothing changed, and for other users and Apps', async () => {
    const { h, send } = setup();
    const [user, other] = [fresh(), fresh()];
    const mine = await h.connect(user, 'Portal');
    const bystander = await h.connect(other, 'Portal');
    const otherApp = await h.connect(user, 'CRMS');
    await send([user]);
    const [id] = await unreadIds(h, user);
    const body = { userId: user, app: 'Portal' };

    await h.postJson(`/notifications/${id}/read`, body);
    await h.postJson(`/notifications/${id}/read`, body); // already read
    await h.postJson('/notifications/read-all', body); // nothing left

    expect(mine.socket.events).toHaveLength(2); // created + one read
    expect(bystander.socket.events).toHaveLength(0);
    expect(otherApp.socket.events).toHaveLength(0);
  });

  it('does not announce a read the user was not allowed to make', async () => {
    const { h, send } = setup();
    const [owner, thief] = [fresh(), fresh()];
    const ownerConn = await h.connect(owner, 'Portal');
    await send([owner]);
    const [id] = await unreadIds(h, owner);
    const res = await h.postJson(`/notifications/${id}/read`, {
      userId: thief,
      app: 'Portal',
    });
    expect(res.status).toBe(404);
    expect(ownerConn.socket.events).toHaveLength(1);
  });
});
