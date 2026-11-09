import { afterEach, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { app } from '../src/app';
import { createLive } from '../src/node/live';
import { createHarness, GATEWAY_SECRET } from './harness';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.useRealTimers();
});

async function setup() {
  const live = createLive();
  // Live delivery and heartbeat must work with every external service unavailable.
  const { env, smtpCalls } = createHarness({
    ...live.bindings,
    DATABASE_URL: 'postgres://unreachable:1/no-database',
    EMAIL_QUEUE: {
      send() {
        throw new Error('Heartbeat cannot enqueue Email');
      },
    },
  });
  const fetch = (request: Request) => Promise.resolve(app.fetch(request, env));
  const server = serve({ fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  live.attach(server, fetch);
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    live.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function connect(
    path: string,
    autoPong = true,
    secret = GATEWAY_SECRET,
  ) {
    const socket = new WebSocket(base.replace('http:', 'ws:') + path, {
      autoPong,
      headers: { 'x-gateway-secret': secret },
    });
    socket.on('error', () => {});
    const messages: string[] = [];
    socket.on('message', (data) =>
      messages.push(
        new TextDecoder().decode(
          Array.isArray(data) ? Buffer.concat(data) : data,
        ),
      ),
    );
    await once(socket, 'open');
    return { socket, messages };
  }
  async function barrier(client: Awaited<ReturnType<typeof connect>>) {
    const message = once(client.socket, 'message');
    client.socket.send('ping');
    await message;
    expect(client.messages.pop()).toBe('pong');
  }
  const publish = (body = {}, token = 'test-token-0123456789') =>
    globalThis.fetch(`${base}/orders/changed`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  return { connect, barrier, publish, smtpCalls };
}

it('drops a silent dead socket within two 30-second intervals and keeps a healthy idle socket open', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const h = await setup();
  const healthy = await h.connect('/live?userId=staff&app=crms');
  const dead = await h.connect('/orders/live?userId=customer', false);
  const healthyPing = once(healthy.socket, 'ping');
  const deadPing = once(dead.socket, 'ping');
  await vi.advanceTimersByTimeAsync(30_000);
  await Promise.all([healthyPing, deadPing]);
  // This frame follows the automatic protocol pong and is a processing barrier.
  await h.barrier(healthy);
  const closed = once(dead.socket, 'close');
  const secondPing = once(healthy.socket, 'ping');
  await vi.advanceTimersByTimeAsync(30_000);
  await Promise.all([closed, secondPing]);
  await h.barrier(healthy);
  expect(dead.socket.readyState).toBe(WebSocket.CLOSED);
  expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
  expect(healthy.messages).toEqual([]);
  expect(h.smtpCalls).toEqual([]);
});

it('broadcasts only a payload-free orders.changed signal to every Staff socket, with no replay', async () => {
  const h = await setup();
  expect(await (await h.publish()).json()).toEqual({ connected: 0 });
  const staff = await h.connect('/orders/staff/live?userId=staff-1');
  const tab = await h.connect('/orders/staff/live?userId=staff-1');
  const colleague = await h.connect('/orders/staff/live?userId=staff-2');
  const customer = await h.connect('/orders/live?userId=staff-1');
  const bell = await h.connect('/live?userId=staff-1&app=crms');
  expect(staff.messages).toEqual([]);
  const received = [staff, tab, colleague].map((client) =>
    once(client.socket, 'message'),
  );
  expect(await (await h.publish()).json()).toEqual({ connected: 3 });
  await Promise.all(received);
  for (const client of [staff, tab, colleague])
    expect(client.messages.map((message) => JSON.parse(message))).toEqual([
      { type: 'orders.changed' },
    ]);
  for (const client of [customer, bell]) {
    await h.barrier(client);
    expect(client.messages).toEqual([]);
  }
  const returning = await h.connect('/orders/staff/live?userId=staff-3');
  await h.barrier(returning);
  expect(returning.messages).toEqual([]);
  staff.socket.send(JSON.stringify({ type: 'orders.changed' }));
  await h.barrier(staff);
  await h.barrier(colleague);
  expect(colleague.messages).toHaveLength(1);
});

it('refuses unauthorised publish and payloads with private Order data', async () => {
  const h = await setup();
  expect((await h.publish({}, 'wrong')).status).toBe(401);
  expect((await h.publish({ orderId: 'private' })).status).toBe(400);
  await expect(
    h.connect('/orders/staff/live?userId=staff', true, 'wrong'),
  ).rejects.toThrow();
});
