import { describe, expect, it } from 'vitest';
import { GATEWAY_SECRET, createHarness } from './harness';

const routes = [
  ['/live?userId=u1&app=Portal', 'user inbox'],
  ['/conversations/t1/live?userId=u1&role=Customer', 'Ticket conversation'],
] as const;

describe.each(routes)('%s (%s)', (path) => {
  const upgrade = { upgrade: 'websocket' };

  it('rejects a connection without the gateway secret', async () => {
    const res = await createHarness().request(
      path,
      { headers: upgrade },
      false,
    );
    expect(res.status).toBe(401);
  });

  it('rejects a wrong gateway secret', async () => {
    const res = await createHarness().request(
      path,
      {
        headers: { ...upgrade, 'x-gateway-secret': 'wrong-secret-0123456789' },
      },
      false,
    );
    expect(res.status).toBe(401);
  });

  it('upgrades a connection that carries the gateway secret', async () => {
    const res = await createHarness().request(
      path,
      { headers: { ...upgrade, 'x-gateway-secret': GATEWAY_SECRET } },
      false,
    );
    expect(res.status).toBe(200); // 101 inside workerd
  });
});

describe('open routes and configuration', () => {
  it('keeps the docs and OpenAPI routes open', async () => {
    const h = createHarness();
    expect((await h.request('/docs', {}, false)).status).toBe(200);
    expect((await h.request('/openapi.json', {}, false)).status).toBe(200);
  });

  it('fails when the gateway secret is not configured', async () => {
    const h = createHarness({ GATEWAY_SECRET: undefined });
    const res = await h.request(
      '/live?userId=u1&app=Portal',
      { headers: { upgrade: 'websocket', 'x-gateway-secret': GATEWAY_SECRET } },
      false,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('GATEWAY_SECRET'),
    });
  });
});
