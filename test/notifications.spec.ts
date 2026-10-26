import { describe, expect, it } from 'vitest';
import { createHarness } from './harness';

const base = {
  type: 'order.shipped',
  title: 'Order shipped',
  body: 'Your order is on its way.',
  sendingApp: 'POS',
  targetApp: 'Portal',
};

let n = 0;
const fresh = () => `user-${Date.now()}-${n++}`;

function setup() {
  const h = createHarness();
  const send = async (extra: Record<string, unknown>) => {
    // Distinct creation times, so ordering across sends is deterministic.
    await new Promise((r) => setTimeout(r, 3));
    return h.postJson('/notifications', { ...base, ...extra });
  };
  const list = async (userId: string, app = 'Portal', query = '') => {
    const res = await h.request(
      `/notifications?userId=${userId}&app=${app}${query}`,
    );
    return { res, ...((await res.json()) as any) };
  };
  const count = async (userId: string, app = 'Portal') =>
    (
      (await (
        await h.request(
          `/notifications/unread-count?userId=${userId}&app=${app}`,
        )
      ).json()) as any
    ).unread as number;
  return { h, send, list, count };
}

describe('sending Notifications', () => {
  it('does not store or push a retry twice, even after the original was read', async () => {
    const { h, send, list, count } = setup();
    const userId = fresh();
    const { socket } = await h.connect(userId, 'Portal');
    const payload = {
      userIds: [userId],
      idempotencyKey: 'order.delivered:245',
    };
    const first = await send(payload);
    const { notifications } = (await first.json()) as any;
    await h.postJson(`/notifications/${notifications[0].id}/read`, {
      userId,
      app: 'Portal',
    });
    const before = socket.received.length;
    const retry = await send(payload);
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as any).stored).toBe(0);
    expect((await list(userId)).notifications).toHaveLength(1);
    expect(await count(userId)).toBe(0);
    expect(socket.received).toHaveLength(before);
  });

  it('stores one Notification per recipient, unread, with a creation time', async () => {
    const { send, list } = setup();
    const [a, b] = [fresh(), fresh()];
    const res = await send({ userIds: [a, b], link: 'https://x.test/o/1' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).notifications).toHaveLength(2);

    const { notifications } = await list(a);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: 'order.shipped',
      title: 'Order shipped',
      body: 'Your order is on its way.',
      link: 'https://x.test/o/1',
      sendingApp: 'POS',
      targetApp: 'Portal',
      userId: a,
      readAt: null,
    });
    expect(notifications[0].createdAt).toBeTruthy();
    expect((await list(b)).notifications).toHaveLength(1);
  });

  it('deduplicates concurrent sends per App and recipient without suppressing other events', async () => {
    const { send, list } = setup();
    const [a, b] = [fresh(), fresh()];
    const payload = { userIds: [a], idempotencyKey: 'order.delivered:245' };
    const responses = await Promise.all([
      send(payload),
      send(payload),
      send(payload),
    ]);
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect((await list(a)).notifications).toHaveLength(1);
    await send({ ...payload, userIds: [a, b] });
    expect((await list(a)).notifications).toHaveLength(1);
    expect((await list(b)).notifications).toHaveLength(1);
    await send({ ...payload, targetApp: 'ecommerce' });
    await send({ ...payload, sendingApp: 'ecommerce' });
    await send({ ...payload, idempotencyKey: 'order.delivered:246' });
    expect((await list(a, 'ecommerce')).notifications).toHaveLength(1);
    expect((await list(a)).notifications).toHaveLength(3);
  });

  it('rejects empty or oversized stable keys', async () => {
    const { send } = setup();
    for (const idempotencyKey of ['', 'x'.repeat(256)]) {
      expect((await send({ userIds: [fresh()], idempotencyKey })).status).toBe(
        400,
      );
    }
  });

  it('rejects missing or empty user ids and other invalid input', async () => {
    const { h, send } = setup();
    for (const extra of [{}, { userIds: [] }, { userIds: [''] }]) {
      const res = await send(extra);
      expect(res.status).toBe(400);
      const { errors } = (await res.json()) as any;
      expect(Object.keys(errors).every((k) => k.startsWith('userIds'))).toBe(
        true,
      );
    }
    const res = await send({ userIds: ['u'], title: '', link: 'nope' });
    expect(res.status).toBe(400);
    expect(Object.keys(((await res.json()) as any).errors).sort()).toEqual([
      'link',
      'title',
    ]);
    expect((await h.postJson('/notifications', undefined)).status).toBe(400);
  });

  it('requires the API token', async () => {
    const { h } = setup();
    expect(
      (await h.request('/notifications?userId=a&app=b', {}, false)).status,
    ).toBe(401);
  });
});

describe('listing', () => {
  it('lists newest first with stable paging while new ones arrive', async () => {
    const { send, list } = setup();
    const u = fresh();
    for (let i = 1; i <= 5; i++) await send({ userIds: [u], title: `n${i}` });

    const p1 = await list(u, 'Portal', '&limit=2');
    expect(p1.notifications.map((x: any) => x.title)).toEqual(['n5', 'n4']);
    expect(p1.nextCursor).toBeTruthy();

    await send({ userIds: [u], title: 'n6' });

    const p2 = await list(u, 'Portal', `&limit=2&cursor=${p1.nextCursor}`);
    expect(p2.notifications.map((x: any) => x.title)).toEqual(['n3', 'n2']);
    const p3 = await list(u, 'Portal', `&limit=2&cursor=${p2.nextCursor}`);
    expect(p3.notifications.map((x: any) => x.title)).toEqual(['n1']);
    expect(p3.nextCursor).toBeNull();
  });

  it('pages stably across Notifications sharing a creation time', async () => {
    const { h, list } = setup();
    const u = fresh();
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        h.postJson('/notifications', { ...base, userIds: [u] }),
      ),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await list(
        u,
        'Portal',
        `&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.notifications.map((x: any) => x.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
  });

  it('filters to unread', async () => {
    const { h, send, list } = setup();
    const u = fresh();
    await send({ userIds: [u], title: 'a' });
    await send({ userIds: [u], title: 'b' });
    const [first] = (await list(u)).notifications;
    await h.postJson(`/notifications/${first.id}/read`, {
      userId: u,
      app: 'Portal',
    });
    const unread = await list(u, 'Portal', '&unread=true');
    expect(unread.notifications).toHaveLength(1);
    expect(unread.notifications[0].title).toBe('a');
  });

  it("never includes another user's or another App's Notifications", async () => {
    const { send, list } = setup();
    const [a, b] = [fresh(), fresh()];
    await send({ userIds: [a] });
    await send({ userIds: [b] });
    await send({ userIds: [a], targetApp: 'CRMS' });
    expect((await list(a)).notifications).toHaveLength(1);
    expect((await list(a, 'CRMS')).notifications).toHaveLength(1);
    expect((await list(a, 'HRMS')).notifications).toHaveLength(0);
  });

  it('rejects an invalid cursor', async () => {
    const { list } = setup();
    expect((await list(fresh(), 'Portal', '&cursor=garbage')).res.status).toBe(
      400,
    );
  });

  it('rejects a list request without user and app', async () => {
    const { h } = setup();
    expect((await h.request('/notifications')).status).toBe(400);
  });
});

describe('read state', () => {
  it('counts unread, and marks one read persistently', async () => {
    const { h, send, list, count } = setup();
    const u = fresh();
    await send({ userIds: [u] });
    await send({ userIds: [u] });
    expect(await count(u)).toBe(2);

    const [first] = (await list(u)).notifications;
    const res = await h.postJson(`/notifications/${first.id}/read`, {
      userId: u,
      app: 'Portal',
    });
    expect(res.status).toBe(200);
    expect(await count(u)).toBe(1);
    const after = (await list(u)).notifications.find(
      (x: any) => x.id === first.id,
    );
    expect(after.readAt).toBeTruthy();

    // Marking again keeps the original read time.
    await h.postJson(`/notifications/${first.id}/read`, {
      userId: u,
      app: 'Portal',
    });
    const again = (await list(u)).notifications.find(
      (x: any) => x.id === first.id,
    );
    expect(again.readAt).toBe(after.readAt);
  });

  it("cannot mark someone else's Notification read", async () => {
    const { h, send, list, count } = setup();
    const [a, b] = [fresh(), fresh()];
    await send({ userIds: [a] });
    const [n] = (await list(a)).notifications;
    for (const body of [
      { userId: b, app: 'Portal' },
      { userId: a, app: 'CRMS' },
    ]) {
      expect(
        (await h.postJson(`/notifications/${n.id}/read`, body)).status,
      ).toBe(404);
    }
    expect(await count(a)).toBe(1);
    expect(
      (
        await h.postJson('/notifications/not-a-uuid/read', {
          userId: a,
          app: 'Portal',
        })
      ).status,
    ).toBe(404);
  });

  it("marks all of a user's Notifications in an App read, leaving others", async () => {
    const { h, send, count } = setup();
    const [a, b] = [fresh(), fresh()];
    await send({ userIds: [a, b] });
    await send({ userIds: [a] });
    await send({ userIds: [a], targetApp: 'CRMS' });
    const res = await h.postJson('/notifications/read-all', {
      userId: a,
      app: 'Portal',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).updated).toBe(2);
    expect(await count(a)).toBe(0);
    expect(await count(a, 'CRMS')).toBe(1);
    expect(await count(b)).toBe(1);
  });
});

describe('direct Notification lookup', () => {
  it('finds an old copy by retry key or id without paging, scoped to its recipient, target and sender', async () => {
    const { h, send } = setup();
    const userId = fresh();
    const response = await send({
      userIds: [userId],
      idempotencyKey: 'creoms.order.7',
      sendingApp: 'CREOMS',
    });
    const [copy] = ((await response.json()) as any).notifications;
    const lookup = (extra: Record<string, string>) =>
      h.request(
        `/notifications/lookup?${new URLSearchParams({ userId, app: 'Portal', ...extra })}`,
      );
    const byKey = await lookup({
      sendingApp: 'CREOMS',
      idempotencyKey: 'creoms.order.7',
    });
    expect(byKey.status).toBe(200);
    expect(((await byKey.json()) as any).notification.id).toBe(copy.id);
    const byId = await lookup({ id: copy.id });
    expect(((await byId.json()) as any).notification.id).toBe(copy.id);
    const otherInboxes: Record<string, string>[] = [
      { id: copy.id, userId: fresh() },
      { id: copy.id, app: 'other' },
      { sendingApp: 'other', idempotencyKey: 'creoms.order.7' },
    ];
    for (const extra of otherInboxes) {
      expect(
        ((await (await lookup(extra)).json()) as any).notification,
      ).toBeNull();
    }
    expect((await lookup({ idempotencyKey: 'creoms.order.7' })).status).toBe(
      400,
    );
    expect(
      (
        await h.request(
          '/notifications/lookup?userId=x&app=Portal&id=' + copy.id,
          {},
          false,
        )
      ).status,
    ).toBe(401);
  });
});
