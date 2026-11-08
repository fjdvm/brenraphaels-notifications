import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:8080';
const container = process.env.SMOKE_CONTAINER;
assert.ok(container, 'SMOKE_CONTAINER is required for the restart check');
const token = process.env.API_TOKEN ?? 'smoke-token-0123456789';
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};
const request = (path, init = {}) =>
  fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(5000),
    headers,
    ...init,
  });

// A temporary SMTP failure before STARTTLS: no credentials or certificates needed.
const connections = [];
const sockets = new Set();
const smtp = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  connections.push(Date.now());
  socket.end('421 Smoke relay temporarily unavailable\r\n');
});
await new Promise((resolve, reject) => {
  smtp.once('error', reject);
  smtp.listen(
    Number(process.env.SMOKE_SMTP_PORT ?? 18088),
    '127.0.0.1',
    resolve,
  );
});

async function until(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await pause(100);
    }
  }
}

try {
  await until(async () => assert.equal((await request('/health')).status, 200));
  const created = await request('/emails/app', {
    method: 'POST',
    body: JSON.stringify({
      to: 'timer-smoke@example.com',
      app: 'CI',
      title: 'Email timer smoke test',
      body: 'Temporary SMTP failure and startup recovery',
    }),
  });
  assert.equal(created.status, 202, await created.clone().text());
  const { id } = await created.json();
  const status = async () => {
    const response = await request(`/emails/${id}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await until(async () => {
    const email = await status();
    assert.equal(email.status, 'queued');
    assert.equal(email.attempts, 1);
    assert.match(email.failureReason, /421/);
    return email;
  });
  assert.equal(connections.length, 1);

  execFileSync('docker', ['restart', container], {
    stdio: 'inherit',
    timeout: 45_000,
  });
  await until(async () => assert.equal((await request('/health')).status, 200));
  const due = Date.parse(first.updatedAt) + 30_000;
  assert.ok(Date.now() < due - 1000, 'Restart must finish before retry is due');
  await pause(Math.max(0, due - Date.now() - 1000));
  assert.equal(
    connections.length,
    1,
    'No early or duplicate attempt after restart',
  );
  assert.equal((await status()).attempts, 1);

  const second = await until(async () => {
    const email = await status();
    assert.equal(email.status, 'queued');
    assert.equal(email.attempts, 2);
    return email;
  }, 5000);
  assert.equal(connections.length, 2);
  assert.ok(connections[1] >= due - 100, 'Retry must wait for its due time');
  assert.ok(connections[1] <= due + 5000, 'Retry must fire on time');
  assert.equal(second.messageId, first.messageId);
  await pause(1000);
  assert.equal(connections.length, 2, 'Only one recovered timer should fire');
  console.log(
    'Container Email smoke passed: temporary failure, due timer, restart recovery and no duplicates',
  );
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => smtp.close(resolve));
}
