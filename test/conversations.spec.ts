import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_LENGTH,
  conversationEvent,
} from '../src/conversations/schemas';
import { createHarness } from './harness';

let n = 0;
const ticket = () => `ticket-${Date.now()}-${n++}`;

/** Every event a socket received must match the published schema. */
const events = (s: { events: any[] }) =>
  s.events.map((e) => conversationEvent.parse(e));

async function room() {
  const h = createHarness();
  const t = ticket();
  const customer = (await h.join(t, 'cust-1', 'Customer')).socket;
  const staff = (await h.join(t, 'staff-1', 'Staff')).socket;
  return { h, t, customer, staff };
}

const msg = (id: string, text = 'hello') => ({ type: 'message', id, text });

describe('joining a room', () => {
  it('upgrades without the API token', async () => {
    const h = createHarness();
    const { res, socket } = await h.join(ticket(), 'u', 'Customer');
    expect(res.status).toBe(200);
    expect(socket).toBeDefined();
  });

  it('rejects a missing user id, an unknown role and a non-WebSocket request', async () => {
    const h = createHarness();
    const t = ticket();
    const get = (q: string) =>
      h.request(`/conversations/${t}/live?${q}`, {}, false);
    expect((await get('role=Staff')).status).toBe(400);
    expect((await get('userId=u&role=Admin')).status).toBe(400);
    expect((await get('userId=u&role=Staff')).status).toBe(426);
  });
});

describe('relaying messages', () => {
  it('delivers to others with sender, text, own id and a service time', async () => {
    const { customer, staff } = await room();
    const before = Date.now();
    customer.say(msg('m1', 'need help'));
    const got = events(staff).find((e) => e.type === 'message')!;
    expect(got).toMatchObject({
      id: 'm1',
      text: 'need help',
      from: { userId: 'cust-1', role: 'Customer' },
    });
    const sentAt = Date.parse((got as any).sentAt);
    expect(sentAt).toBeGreaterThanOrEqual(before);
    expect(sentAt).toBeLessThanOrEqual(Date.now());
  });

  it('ignores a time claimed by the sender', async () => {
    const { customer, staff } = await room();
    customer.say({ ...msg('m1'), sentAt: '2001-01-01T00:00:00.000Z' });
    const got = events(staff).find((e) => e.type === 'message') as any;
    expect(got.sentAt.startsWith('2001')).toBe(false);
  });

  it("reaches the sender's other tabs but not the sending connection", async () => {
    const { h, t, customer, staff } = await room();
    const tab2 = (await h.join(t, 'cust-1', 'Customer')).socket;
    customer.say(msg('m1'));
    expect(events(tab2).filter((e) => e.type === 'message')).toHaveLength(1);
    expect(events(staff).filter((e) => e.type === 'message')).toHaveLength(1);
    expect(events(customer).filter((e) => e.type === 'message')).toHaveLength(
      0,
    );
  });

  it('tells the sender how many other connections received it', async () => {
    const { h, t, customer } = await room(); // customer + staff
    const tab2 = (await h.join(t, 'cust-1', 'Customer')).socket;
    customer.say(msg('m1'));
    expect(
      events(customer).filter((e) => e.type === 'message.delivered'),
    ).toEqual([{ type: 'message.delivered', id: 'm1', delivered: 2 }]);
    tab2.leave();
    customer.say(msg('m2'));
    expect(events(customer).at(-1)).toEqual({
      type: 'message.delivered',
      id: 'm2',
      delivered: 1,
    });
  });

  it('reports zero delivered when nobody else is connected, and does not hold the message', async () => {
    const h = createHarness();
    const t = ticket();
    const alone = (await h.join(t, 'cust-1', 'Customer')).socket;
    alone.say(msg('m1'));
    expect(events(alone).at(-1)).toEqual({
      type: 'message.delivered',
      id: 'm1',
      delivered: 0,
    });
    // Someone arriving later, even the same person, gets no history.
    const late = (await h.join(t, 'staff-1', 'Staff')).socket;
    const again = (await h.join(t, 'cust-1', 'Customer')).socket;
    expect(
      late.received.filter((m) => JSON.parse(m).type === 'message'),
    ).toEqual([]);
    expect(again.received).toEqual([]);
  });

  it('keeps different Tickets fully separate', async () => {
    const h = createHarness();
    const a = (await h.join(ticket(), 'cust-1', 'Customer')).socket;
    const b = (await h.join(ticket(), 'staff-1', 'Staff')).socket;
    a.say(msg('m1'));
    expect(b.received).toEqual([]);
    expect(events(a).at(-1)).toMatchObject({ delivered: 0 });
  });
});

describe('presence', () => {
  it('tells the others when someone connects and disconnects', async () => {
    const h = createHarness();
    const t = ticket();
    const customer = (await h.join(t, 'cust-1', 'Customer')).socket;
    const staff = (await h.join(t, 'staff-1', 'Staff')).socket;
    expect(events(customer)).toEqual([
      {
        type: 'presence',
        event: 'connected',
        userId: 'staff-1',
        role: 'Staff',
      },
    ]);
    expect(staff.received).toEqual([]);
    staff.leave();
    expect(events(customer).at(-1)).toEqual({
      type: 'presence',
      event: 'disconnected',
      userId: 'staff-1',
      role: 'Staff',
    });
  });
});

describe('rejecting bad input', () => {
  it.each([
    ['not json', 'not json {'],
    ['an unknown frame type', { type: 'typing' }],
    ['a missing id', { type: 'message', text: 'hi' }],
    ['empty text', msg('m1', '')],
    ['non-string text', { type: 'message', id: 'm1', text: 5 }],
    ['a binary frame', new ArrayBuffer(4)],
  ])('rejects %s without relaying', async (_name, frame) => {
    const { customer, staff } = await room();
    customer.say(frame);
    expect(events(customer).at(-1)).toMatchObject({
      type: 'error',
      code: 'malformed',
    });
    expect(staff.received).toEqual([]);
  });

  it('rejects text over the limit, naming the message', async () => {
    const { customer, staff } = await room();
    customer.say(msg('big', 'x'.repeat(MAX_TEXT_LENGTH + 1)));
    expect(events(customer).at(-1)).toMatchObject({
      type: 'error',
      code: 'too_long',
      id: 'big',
    });
    customer.say(msg('ok', 'x'.repeat(MAX_TEXT_LENGTH)));
    expect(events(staff).at(-1)).toMatchObject({ type: 'message', id: 'ok' });
  });

  it('rate limits each connection separately', async () => {
    const { h, t, customer, staff } = await room();
    for (let i = 0; i < 20; i++) customer.say(msg(`m${i}`));
    customer.say(msg('over'));
    expect(events(customer).at(-1)).toMatchObject({
      type: 'error',
      code: 'rate_limited',
    });
    expect(
      events(staff).filter((e) => e.type === 'message' && e.id === 'over'),
    ).toEqual([]);
    // Bad frames use up the allowance too.
    const flooder = (await h.join(t, 'cust-2', 'Customer')).socket;
    for (let i = 0; i < 21; i++) flooder.say('garbage');
    expect(events(flooder).at(-1)).toMatchObject({ code: 'rate_limited' });
    // Another connection, even the same user's, has its own allowance.
    const tab2 = (await h.join(t, 'cust-1', 'Customer')).socket;
    tab2.say(msg('fresh'));
    expect(events(staff).at(-1)).toMatchObject({
      type: 'message',
      id: 'fresh',
    });
  });
});

describe('storage', () => {
  it('writes no rows anywhere', async () => {
    const sql = postgres(createHarness().env.DATABASE_URL as string, {
      max: 1,
    });
    const count = async () => {
      const tables =
        await sql`select table_name from information_schema.tables where table_schema = 'public'`;
      let total = 0;
      for (const { table_name } of tables)
        total += (
          await sql`select count(*)::int as n from ${sql(table_name)}`
        )[0]!.n;
      return total;
    };
    try {
      const before = await count();
      const { customer, staff } = await room();
      customer.say(msg('m1'));
      staff.say(msg('m2'));
      customer.say('garbage');
      staff.leave();
      expect(await count()).toBe(before);
    } finally {
      await sql.end();
    }
  });
});
