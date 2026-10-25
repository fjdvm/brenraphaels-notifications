import { expect, it } from 'vitest';
import { createHarness, GATEWAY_SECRET } from './harness';
import type { FakeSocket } from './fake-durable-objects';

it('relays Order and Return events only to the named Customer, across tabs', async () => {
  const h = createHarness();
  const connect = async (userId: string) => {
    const res = await h.request(
      `/orders/live?userId=${userId}`,
      {
        headers: { upgrade: 'websocket', 'x-gateway-secret': GATEWAY_SECRET },
      },
      false,
    );
    expect(res.status).toBe(200);
    return (res as Response & { webSocket: FakeSocket }).webSocket;
  };
  const first = await connect('customer-1');
  const tab = await connect('customer-1');
  const other = await connect('customer-2');
  const bell = (await h.connect('customer-1', 'ecommerce')).socket;
  for (const event of [
    { type: 'order.updated', orderId: 'o1' },
    { type: 'return.updated', orderId: 'o1', returnId: 'r1' },
  ]) {
    const res = await h.postJson('/orders/events', {
      customerId: 'customer-1',
      event,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: 2 });
    expect(first.events.at(-1)).toEqual(event);
    expect(tab.events.at(-1)).toEqual(event);
  }
  expect(other.events).toEqual([]);
  expect(bell.events).toEqual([]);
});

it('drops offline events, keeps no replay, and ignores browser attempts to publish', async () => {
  // No database is reachable: this channel must not attempt to persist anything.
  const h = createHarness({
    DATABASE_URL: 'postgres://unreachable:1/no-database',
  });
  const event = { type: 'order.updated', orderId: 'o1' };
  expect(
    await (
      await h.postJson('/orders/events', { customerId: 'c1', event })
    ).json(),
  ).toEqual({ connected: 0 });
  const join = async () => {
    const res = await h.request(
      '/orders/live?userId=c1',
      {
        headers: { upgrade: 'websocket', 'x-gateway-secret': GATEWAY_SECRET },
      },
      false,
    );
    expect(res.status).toBe(200);
    return (res as Response & { webSocket: FakeSocket }).webSocket;
  };
  const first = await join();
  const second = await join();
  expect(first.events).toEqual([]);
  expect(second.events).toEqual([]);
  first.say(event);
  expect(second.events).toEqual([]);
  first.leave();
  expect(
    await (
      await h.postJson('/orders/events', { customerId: 'c1', event })
    ).json(),
  ).toEqual({ connected: 1 });
  expect(second.events).toEqual([event]);
  expect((await join()).events).toEqual([]);
});

it('requires gateway authentication to connect and service authentication to publish', async () => {
  const h = createHarness();
  expect((await h.request('/orders/live?userId=c1')).status).toBe(401);
  expect(
    (
      await h.request(
        '/orders/live?userId=c1',
        { headers: { 'x-gateway-secret': 'wrong' } },
        false,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await h.request(
        '/orders/live?userId=c1',
        { headers: { 'x-gateway-secret': GATEWAY_SECRET } },
        false,
      )
    ).status,
  ).toBe(426);
  expect(
    (
      await h.request(
        '/orders/live',
        { headers: { 'x-gateway-secret': GATEWAY_SECRET } },
        false,
      )
    ).status,
  ).toBe(400);
  expect(
    (await h.request('/orders/events', { method: 'POST' }, false)).status,
  ).toBe(401);
});

it('rejects invalid publish input instead of forwarding arbitrary data', async () => {
  const h = createHarness();
  for (const body of [
    {},
    { customerId: '', event: { type: 'order.updated', orderId: 'o1' } },
    { customerId: 'c1', event: { type: 'return.updated', orderId: 'o1' } },
    { customerId: 'c1', event: { type: 'unknown', orderId: 'o1' } },
    { customerId: 'c1', event: { type: 'order.updated', orderId: '' } },
    {
      customerId: 'c1',
      event: { type: 'order.updated', orderId: 'o1', privateData: 'secret' },
    },
  ])
    expect((await h.postJson('/orders/events', body)).status).toBe(400);
  expect(
    (await h.request('/orders/events', { method: 'POST', body: 'not json' }))
      .status,
  ).toBe(400);
});
