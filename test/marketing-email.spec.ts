import { describe, expect, it } from 'vitest';
import { createHarness } from './harness';

const valid = {
  to: 'subscriber@example.com',
  app: 'CRMS',
  subscriberConsent: true,
  title: 'Autumn sale',
  body: 'Everything is 20% off.',
  images: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
};

const errorsOf = async (res: Response) => ((await res.json()) as any).errors;

describe('requesting a Marketing email', () => {
  it('answers queued with an id and records consent on the Email', async () => {
    const h = createHarness();
    const res = await h.postMarketingEmail(valid);
    expect(res.status).toBe(202);
    const { id, status } = (await res.json()) as any;
    expect(status).toBe('queued');
    expect(h.queued).toEqual([{ emailId: id }]);

    const record = (await (await h.getEmail(id)).json()) as any;
    expect(record).toMatchObject({
      category: 'marketing',
      template: 'marketing',
      recipient: 'subscriber@example.com',
      sendingApp: 'CRMS',
      status: 'queued',
      subscriberConsent: true,
    });
  });

  it('accepts a request with no images', async () => {
    const h = createHarness();
    const { images: _i, ...noImages } = valid;
    expect((await h.postMarketingEmail(noImages)).status).toBe(202);
  });

  it('rejects a request without the Subscriber consent assertion', async () => {
    const h = createHarness();
    const { subscriberConsent: _c, ...missing } = valid;
    const res = await h.postMarketingEmail(missing);
    expect(res.status).toBe(400);
    expect(Object.keys(await errorsOf(res))).toEqual(['subscriberConsent']);
    expect(
      (await h.postMarketingEmail({ ...valid, subscriberConsent: false }))
        .status,
    ).toBe(400);
    expect(h.queued).toHaveLength(0);
  });

  it('rejects any declared App other than CRMS', async () => {
    const h = createHarness();
    const res = await h.postMarketingEmail({ ...valid, app: 'POS' });
    expect(res.status).toBe(400);
    expect(Object.keys(await errorsOf(res))).toEqual(['app']);
    expect(h.queued).toHaveLength(0);
  });

  it('rejects invalid template values with field-level messages', async () => {
    const h = createHarness();
    const res = await h.postMarketingEmail({
      ...valid,
      title: '',
      images: [
        'https://ok.example.com/a.png',
        'http://insecure.example.com/b.png',
      ],
    });
    expect(res.status).toBe(400);
    expect(Object.keys(await errorsOf(res)).sort()).toEqual([
      'images.1',
      'title',
    ]);
  });

  it('requires the API token', async () => {
    const h = createHarness();
    const res = await h.request(
      '/emails/marketing',
      { method: 'POST', body: JSON.stringify(valid) },
      false,
    );
    expect(res.status).toBe(401);
  });
});

describe('Marketing email delivery', () => {
  it('sends from the marketing sender, separate from App emails', async () => {
    const h = createHarness();
    const { id } = (await (await h.postMarketingEmail(valid)).json()) as any;
    await h.postAppEmail({
      to: 'u@example.com',
      app: 'HRMS',
      title: 'Hi',
      body: 'There',
    });
    await h.drainQueue();

    const [marketing, app] = h.smtpCalls.map((c) => c.email);
    expect(marketing.from).toEqual({
      name: 'Test Marketing',
      email: 'marketing@example.com',
    });
    expect(app.from.email).toBe('apps@example.com');
    expect(marketing.subject).toBe('Autumn sale');
    expect(marketing.html).toContain('Everything is 20% off.');
    expect(marketing.html).toContain('src="https://cdn.example.com/a.png"');
    expect(marketing.html).toContain('src="https://cdn.example.com/b.png"');

    const record = (await (await h.getEmail(id)).json()) as any;
    expect(record).toMatchObject({ status: 'sent', attempts: 1 });
    expect(record.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
  });

  it('escapes HTML in user-supplied text', async () => {
    const h = createHarness();
    await h.postMarketingEmail({ ...valid, body: '<script>x</script>' });
    await h.drainQueue();
    expect(h.smtpCalls[0]!.email.html).not.toContain('<script>');
  });
});

describe('Marketing email to a list of Subscribers', () => {
  const { to: _to, ...rest } = valid;
  const list = (recipients: string[]) => ({ ...rest, recipients });

  it('creates and queues one Email per recipient, each with consent', async () => {
    const h = createHarness();
    const res = await h.postMarketingList(
      list(['a@example.com', 'b@example.com']),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.queued).toBe(2);
    expect(h.queued).toHaveLength(2);
    for (const { id, recipient } of body.emails) {
      const record = (await (await h.getEmail(id)).json()) as any;
      expect(record).toMatchObject({
        recipient,
        status: 'queued',
        subscriberConsent: true,
        category: 'marketing',
      });
    }
  });

  it('rejects a list over the configured maximum', async () => {
    const h = createHarness({ MARKETING_MAX_RECIPIENTS: '2' });
    const res = await h.postMarketingList(
      list(['a@example.com', 'b@example.com', 'c@example.com']),
    );
    expect(res.status).toBe(400);
    expect((await errorsOf(res)).recipients[0]).toContain('maximum is 2');
    expect(h.queued).toHaveLength(0);
  });

  it('requires consent for the whole list', async () => {
    const h = createHarness();
    const res = await h.postMarketingList({
      ...list(['a@example.com']),
      subscriberConsent: false,
    });
    expect(res.status).toBe(400);
    expect(h.queued).toHaveLength(0);
  });

  it('sends a duplicate address once', async () => {
    const h = createHarness();
    const res = await h.postMarketingList(
      list(['a@example.com', 'A@Example.com', 'b@example.com']),
    );
    expect(((await res.json()) as any).queued).toBe(2);
    await h.drainQueue();
    expect(h.smtpCalls).toHaveLength(2);
  });

  it('delivers the rest when one recipient fails permanently', async () => {
    const h = createHarness();
    const res = await h.postMarketingList(
      list(['a@example.com', 'bad@example.com', 'c@example.com']),
    );
    const { emails } = (await res.json()) as any;
    h.scriptSmtp('ok', new Error('RCPT TO 550 no such user'), 'ok');
    await h.drainQueue();
    const statuses = await Promise.all(
      emails.map(
        async (e: any) =>
          ((await (await h.getEmail(e.id)).json()) as any).status,
      ),
    );
    expect(statuses).toEqual(['sent', 'failed', 'sent']);
  });

  it('reports only the Emails actually queued when queueing fails for one', async () => {
    const h = createHarness();
    let n = 0;
    (h.env as any).EMAIL_QUEUE = {
      send: async () => {
        if (++n === 2) throw new Error('queue down');
      },
    };
    const res = await h.postMarketingList(
      list(['a@example.com', 'b@example.com', 'c@example.com']),
    );
    const body = (await res.json()) as any;
    expect(body.queued).toBe(2);
    const record = (await (await h.getEmail(body.emails[1].id)).json()) as any;
    expect(record.status).toBe('failed');
  });
});
