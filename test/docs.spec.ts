import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { routes } from '../src/docs/contract';
import { tools } from '../src/mcp/tools';
import { createHarness } from './harness';

const idOf = (method: string, path: string) =>
  `${method}-${path.replace(/[/:]+/g, '-').replace(/^-|-$/g, '')}`;

describe('the guide', () => {
  it('is served without a token', async () => {
    const res = await createHarness().request('/docs', {}, false);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Notifications API');
  });

  it('documents every route in the contract', async () => {
    const html = await (
      await createHarness().request('/docs', {}, false)
    ).text();
    for (const spec of Object.values(routes)) {
      expect(html, `${spec.method} ${spec.path}`).toContain(
        `id:'${idOf(spec.method, spec.path)}'`,
      );
      expect(html).toContain(`path:'${spec.path}'`);
    }
  });

  it('has Start here, the bearer token and every agent client snippet', async () => {
    const html = await (
      await createHarness().request('/docs', {}, false)
    ).text();
    expect(html).toContain('Start here');
    expect(html).toContain('Authorization: Bearer');
    for (const snippet of [
      'claude mcp add --transport http notifications',
      '[mcp_servers.notifications]',
      '.cursor/mcp.json',
      '.kiro/settings/mcp.json',
    ])
      expect(html).toContain(snippet);
  });

  it('lists every MCP tool with each of its arguments', async () => {
    const html = await (
      await createHarness().request('/docs', {}, false)
    ).text();
    for (const tool of tools) {
      const row = html
        .split('\n')
        .find(
          (l) =>
            l.includes(`['<code>${tool.name}</code>','<code>`) &&
            !l.includes('POST /') &&
            !l.includes('GET /'),
        );
      expect(row, `${tool.name} argument row`).toBeDefined();
      for (const arg of Object.keys(tool.input.shape))
        expect(row, `${tool.name}.${arg}`).toContain(`<code>${arg}`);
    }
  });

  it('writes examples against $BASE_URL so the base-URL box can rewrite them', async () => {
    const html = await (
      await createHarness().request('/docs', {}, false)
    ).text();
    expect(html).toContain('id="base"');
    expect(html).toContain("replaceAll('$BASE_URL'");
    expect(html).not.toMatch(/curl[^\n]*"https?:\/\/[^$]/);
  });
});

describe('the OpenAPI document', () => {
  const get = async () =>
    (await (
      await createHarness().request('/openapi.json', {}, false)
    ).json()) as any;

  it('is served without a token', async () => {
    expect((await get()).openapi).toBe('3.1.0');
  });

  it('lists exactly the routes the app serves', async () => {
    const doc = await get();
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${path}`),
    );
    const served = app.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`);
    expect(documented.sort()).toEqual([...new Set(served)].sort());
  });

  it('describes request bodies and dates from the schemas the routes use', async () => {
    const doc = await get();
    const send = doc.paths['/notifications'].post;
    expect(
      send.requestBody.content['application/json'].schema.required,
    ).toContain('userIds');
    const created = send.responses['201'].content['application/json'].schema;
    expect(
      created.properties.notifications.items.properties.createdAt,
    ).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
    const appEmail =
      doc.paths['/emails/app'].post.requestBody.content['application/json']
        .schema;
    expect(appEmail.properties.sendAt).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
    expect(appEmail.required).not.toContain('sendAt');
    expect(doc.paths['/live'].get.security).toEqual([]);
  });
});
