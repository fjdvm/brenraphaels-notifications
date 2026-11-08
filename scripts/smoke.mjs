import assert from 'node:assert/strict';

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:8080';
const token = process.env.API_TOKEN ?? 'smoke-token-0123456789';
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};
const request = (path, init = {}) =>
  fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000), ...init });
assert.equal((await request('/health')).status, 200);
assert.equal(
  (await request('/notifications?app=Portal&userId=smoke')).status,
  401,
);
const userId = `smoke-${crypto.randomUUID()}`;
const created = await request('/notifications', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    type: 'smoke.created',
    title: 'Container smoke test',
    body: 'Stored by Node',
    sendingApp: 'CI',
    targetApp: 'Portal',
    userIds: [userId],
  }),
});
assert.equal(created.status, 201, await created.clone().text());
const {
  notifications: [notification],
  stored,
} = await created.json();
assert.equal(stored, 1);
const read = await request(`/notifications?app=Portal&userId=${userId}`, {
  headers,
});
assert.equal(read.status, 200);
assert.equal((await read.json()).notifications[0].id, notification.id);
assert.equal((await request('/docs')).status, 200);
assert.equal((await request('/openapi.json')).status, 200);
const mcp = await request('/mcp', {
  method: 'POST',
  headers: { ...headers, accept: 'application/json, text/event-stream' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  }),
});
assert.equal(mcp.status, 200, await mcp.clone().text());
assert.ok((await mcp.json()).result.tools.length > 0);
console.log(
  'Container HTTP smoke passed: health, authentication, Notification create/read, docs and MCP',
);
