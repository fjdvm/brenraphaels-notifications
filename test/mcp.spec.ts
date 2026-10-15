import { describe, expect, it } from 'vitest';
import { createHarness } from './harness';

const accept = 'application/json, text/event-stream';

function setup() {
  const h = createHarness();
  const rpc = (method: string, params: object = {}, authed = true) =>
    h.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      },
      authed,
    );
  const call = async (name: string, args: object = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    expect(res.status).toBe(200);
    const { content, isError } = ((await res.json()) as any).result;
    const text = content[0].text as string;
    return {
      isError: Boolean(isError),
      text,
      data: isError ? undefined : JSON.parse(text),
    };
  };
  return { h, rpc, call };
}

let n = 0;
const fresh = () => `mcp-${Date.now()}-${n++}`;

describe('the MCP endpoint', () => {
  it('needs the bearer token', async () => {
    const { rpc } = setup();
    expect((await rpc('tools/list', {}, false)).status).toBe(401);
  });

  it('lists the tools with their input schemas', async () => {
    const { rpc } = setup();
    const { tools } = ((await (await rpc('tools/list')).json()) as any).result;
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      'get_email',
      'get_unread_count',
      'list_notifications',
      'mark_all_notifications_read',
      'mark_notification_read',
      'send_app_email',
      'send_marketing_email',
      'send_marketing_email_list',
      'send_notification',
    ]);
    const send = tools.find((t: any) => t.name === 'send_notification');
    expect(send.inputSchema.required).toContain('userIds');
    expect(send.description.length).toBeGreaterThan(40);
  });

  it('sends, lists, counts and reads Notifications like the API', async () => {
    const { call } = setup();
    const user = fresh();
    const sent = await call('send_notification', {
      type: 'order.shipped',
      title: 'Shipped',
      body: 'On its way',
      sendingApp: 'POS',
      targetApp: 'Portal',
      userIds: [user],
    });
    expect(sent.data).toMatchObject({ stored: 1, connected: 0 });
    const inbox = { userId: user, app: 'Portal' };
    expect((await call('get_unread_count', inbox)).data).toEqual({ unread: 1 });
    const listed = await call('list_notifications', {
      ...inbox,
      unread: 'true',
    });
    expect(listed.data.notifications).toHaveLength(1);
    const id = listed.data.notifications[0].id;
    expect(
      (await call('mark_notification_read', { id, ...inbox })).data,
    ).toEqual({ id, read: true });
    expect((await call('get_unread_count', inbox)).data).toEqual({ unread: 0 });
    expect((await call('mark_all_notifications_read', inbox)).data).toEqual({
      updated: 0,
    });
  });

  it('queues Emails and looks them up', async () => {
    const { call } = setup();
    const queued = await call('send_app_email', {
      to: 'ana@example.com',
      app: 'POS',
      title: 'Receipt',
      body: 'Thanks',
    });
    expect(queued.data.status).toBe('queued');
    const email = await call('get_email', { id: queued.data.id });
    expect(email.data).toMatchObject({
      recipient: 'ana@example.com',
      status: 'queued',
    });
    const list = await call('send_marketing_email_list', {
      recipients: ['a@example.com', 'A@example.com', 'b@example.com'],
      app: 'CRMS',
      subscriberConsent: true,
      title: 'Sale',
      body: 'Now',
    });
    expect(list.data.queued).toBe(2);
  });

  it("returns the API's failure as a tool error the model can read", async () => {
    const { call } = setup();
    const bad = await call('send_marketing_email', {
      to: 'ana@example.com',
      app: 'CRMS',
      subscriberConsent: true,
      title: 'x',
      body: 'y',
      images: ['http://insecure.example/a.jpg'],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('images');
    const missing = await call('get_email', {
      id: '6f0c9a52-3d1e-4c8e-9a53-0f4b8b1d2c77',
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Not found');
    expect((await call('nope')).isError).toBe(true);
  });
});
