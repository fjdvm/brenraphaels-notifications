import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:8080';
const gateway = process.env.GATEWAY_SECRET ?? 'smoke-gateway-0123456789';
const token = process.env.API_TOKEN ?? 'smoke-token-0123456789';
const container = process.env.SMOKE_CONTAINER;
assert.ok(
  container,
  'SMOKE_CONTAINER is required to verify a real server restart',
);
const sockets = new Set();
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};
const request = (path, init = {}) =>
  fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(5000),
    ...init,
  });

async function connect(path, secret = gateway, autoPong = true) {
  const url = new URL(path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, {
    headers: secret === null ? {} : { 'x-gateway-secret': secret },
    handshakeTimeout: 5000,
    autoPong,
  });
  sockets.add(socket);
  const events = [];
  socket.on('message', (data) => events.push(data.toString()));
  // Keep errors observed even when a connection is deliberately rejected or restarted.
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  const status = await new Promise((resolve, reject) => {
    socket.once('open', () => resolve(101));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
  });
  return { socket, events, status };
}

async function until(check, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(`Timed out: ${description}`);
}

function jsonEvents(client) {
  return client.events
    .filter((event) => event !== 'pong')
    .map((event) => JSON.parse(event));
}

async function message(
  client,
  id,
  text = 'Hello from the container smoke test',
) {
  client.socket.send(JSON.stringify({ type: 'message', id, text }));
  await until(
    () =>
      jsonEvents(client).some(
        (event) => event.type === 'message.delivered' && event.id === id,
      ),
    'Conversation delivery acknowledgement',
  );
  return jsonEvents(client).find(
    (event) => event.type === 'message.delivered' && event.id === id,
  );
}

// A pong is a processing barrier for every preceding frame on this connection.
async function ping(client) {
  const previous = client.events.filter((event) => event === 'pong').length;
  client.socket.send('ping');
  await until(
    () => client.events.filter((event) => event === 'pong').length > previous,
    'keep-alive pong',
  );
}

async function exercise(label) {
  const id = `${label}-${crypto.randomUUID()}`;
  const path = `/conversations/${id}/live?userId=customer&role=Customer`;
  const a = await connect(path);
  assert.equal(a.status, 101);
  const b = await connect(`/conversations/${id}/live?userId=staff&role=Staff`);
  const outsider = await connect(
    `/conversations/other-${id}/live?userId=other&role=Customer`,
  );
  assert.equal(b.status, 101);
  assert.equal(outsider.status, 101);
  assert.equal((await message(a, 'customer-message')).delivered, 1);
  await until(
    () => jsonEvents(b).some((event) => event.id === 'customer-message'),
    'Customer message reaches Staff',
  );
  assert.deepEqual(
    jsonEvents(b).find((event) => event.id === 'customer-message').from,
    { userId: 'customer', role: 'Customer' },
  );
  assert.equal((await message(b, 'staff-message')).delivered, 1);
  await until(
    () => jsonEvents(a).some((event) => event.id === 'staff-message'),
    'Staff reply reaches Customer',
  );
  await ping(outsider);
  assert.deepEqual(jsonEvents(outsider), []);

  // With the peer offline there is no replay when it returns.
  b.socket.close();
  await until(
    () =>
      jsonEvents(a).some(
        (event) => event.type === 'presence' && event.event === 'disconnected',
      ),
    'Staff leaves',
  );
  assert.equal((await message(a, 'offline-message')).delivered, 0);
  const returning = await connect(
    `/conversations/${id}/live?userId=staff&role=Staff`,
  );
  await ping(returning);
  assert.deepEqual(jsonEvents(returning), []);

  const recipient = await connect(`/live?app=Portal&userId=${id}`);
  const tab = await connect(`/live?app=Portal&userId=${id}`);
  const otherUser = await connect(`/live?app=Portal&userId=other-${id}`);
  const otherApp = await connect(`/live?app=CRMS&userId=${id}`);
  for (const client of [recipient, tab, otherUser, otherApp])
    assert.equal(client.status, 101);
  const result = await request('/notifications', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'smoke.live',
      title: 'Live smoke',
      body: 'Pushed without polling',
      sendingApp: 'CI',
      targetApp: 'Portal',
      userIds: [id],
    }),
  });
  assert.equal(result.status, 201, await result.clone().text());
  const created = await result.json();
  assert.equal(created.connected, 1);
  for (const client of [recipient, tab]) {
    await until(
      () =>
        jsonEvents(client).some(
          (event) => event.type === 'notification.created',
        ),
      'Notification pushed to every tab',
    );
    assert.equal(
      jsonEvents(client)[0].notification.id,
      created.notifications[0].id,
    );
  }

  const orders = await connect(`/orders/live?userId=${id}`);
  const otherOrders = await connect(`/orders/live?userId=other-${id}`);
  assert.equal(orders.status, 101);
  assert.equal(otherOrders.status, 101);
  const event = { type: 'order.updated', orderId: id };
  const published = await request('/orders/events', {
    method: 'POST',
    headers,
    body: JSON.stringify({ customerId: id, event }),
  });
  assert.equal(published.status, 200, await published.clone().text());
  await until(() => jsonEvents(orders).length === 1, 'Order event pushed');
  assert.deepEqual(jsonEvents(orders), [event]);
  for (const client of [otherUser, otherApp, otherOrders]) {
    await ping(client);
    assert.deepEqual(jsonEvents(client), []);
  }
  assert.equal(
    jsonEvents(recipient).length,
    1,
    'Order events stay out of Notification rooms',
  );
  const staff = await connect(`/orders/staff/live?userId=staff-${id}`);
  const staffTab = await connect(`/orders/staff/live?userId=staff-${id}`);
  const colleague = await connect(`/orders/staff/live?userId=colleague-${id}`);
  for (const client of [staff, staffTab, colleague])
    assert.equal(client.status, 101);
  assert.equal(
    (
      await request('/orders/changed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('/orders/changed', {
        method: 'POST',
        headers,
        body: '{"orderId":"private"}',
      })
    ).status,
    400,
  );
  const changed = await request('/orders/changed', {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).connected, 3);
  for (const client of [staff, staffTab, colleague]) {
    await until(
      () => jsonEvents(client).length === 1,
      'Staff orders-changed signal',
    );
    assert.deepEqual(jsonEvents(client), [{ type: 'orders.changed' }]);
  }
  await ping(otherOrders);
  assert.deepEqual(jsonEvents(otherOrders), []);
  await ping(orders);
  assert.deepEqual(jsonEvents(orders), [event]);
  return { path, clients: [...sockets] };
}

try {
  for (const path of [
    '/live?app=Portal&userId=smoke',
    '/orders/live?userId=smoke',
    '/orders/staff/live?userId=smoke',
    '/conversations/smoke/live?userId=smoke&role=Customer',
  ]) {
    for (const secret of [null, 'invalid-gateway-secret']) {
      assert.equal((await connect(path, secret)).status, 401);
    }
  }
  const before = await exercise('before-restart');
  const healthy = await connect('/live?app=Portal&userId=heartbeat-healthy');
  const dead = await connect(
    '/live?app=Portal&userId=heartbeat-dead',
    gateway,
    false,
  );
  let pings = 0;
  healthy.socket.on('ping', () => pings++);
  await until(
    () => dead.socket.readyState === WebSocket.CLOSED,
    'silent dead socket dropped within two heartbeat intervals',
    61_000,
  );
  assert.equal(healthy.socket.readyState, WebSocket.OPEN);
  assert.ok(pings >= 1, 'healthy idle socket receives protocol heartbeat');
  await ping(healthy);
  assert.deepEqual(jsonEvents(healthy), []);
  console.log(
    'Heartbeat passed: dead socket closed within 60 seconds, healthy idle socket stayed open',
  );
  await promisify(execFile)('docker', ['restart', container], {
    timeout: 45000,
  });
  await until(
    async () => {
      try {
        return (await request('/health')).status === 200;
      } catch {
        return false;
      }
    },
    'container healthy after restart',
    30000,
  );
  await until(
    () =>
      before.clients.every((socket) => socket.readyState === WebSocket.CLOSED),
    'old connections close on restart',
  );
  const reconnected = await connect(before.path);
  assert.equal(reconnected.status, 101);
  await ping(reconnected);
  assert.deepEqual(
    jsonEvents(reconnected),
    [],
    'Restart does not replay Conversation history',
  );
  await exercise('after-restart');
  console.log(
    'Container WebSocket smoke passed: gateway auth, Conversation relay/isolation/offline drop, Notification and Order push, restart and reconnect',
  );
} finally {
  for (const socket of sockets) socket.terminate();
}
