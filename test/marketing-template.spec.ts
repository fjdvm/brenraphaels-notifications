import { describe, expect, it } from 'vitest';
import { marketing } from '../src/templates/marketing';

const render = (values: {
  title?: string;
  body?: string;
  images?: string[];
  unsubscribeUrl?: string;
}) =>
  marketing.render(
    marketing.schema.parse({
      title: 'Autumn sale',
      body: 'Everything is 20% off.',
      ...values,
    }),
  );

const img = (n: number) => `https://cdn.example.com/${n}.png`;

describe('marketing template rendering', () => {
  it('renders a text-only email with the brand header and footer', () => {
    const { subject, html } = render({});
    expect(subject).toBe('Autumn sale');
    expect(html).toContain('Autumn sale');
    expect(html).toContain('Everything is 20% off.');
    expect(html).toContain('#452175');
    expect(html).toContain('Georgia');
    expect(html).toContain('logo.jpeg');
    expect(html).not.toMatch(/<img[^>]*cdn\.example\.com/);
  });

  it('renders one image', () => {
    const { html } = render({ images: [img(1)] });
    expect(html.match(/src="https:\/\/cdn\.example\.com\//g)).toHaveLength(1);
  });

  it('renders many images, each full width and in order', () => {
    const { html } = render({ images: [img(1), img(2), img(3)] });
    const at = [1, 2, 3].map((n) => html.indexOf(`src="${img(n)}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(html).toContain('width:100%');
  });

  it('works on phone widths', () => {
    const { html } = render({ images: [img(1)] });
    expect(html).toContain('name="viewport"');
    expect(html).toContain('max-width:600px');
  });

  it('escapes title, body, image addresses and the unsubscribe link', () => {
    const { html } = render({
      title: '<script>t</script>',
      body: '<b onclick="x">hi</b>',
      images: ['https://cdn.example.com/a.png?x="><script>i</script>'],
      unsubscribeUrl: 'https://shop.example.com/u?t="><script>u</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b onclick');
    expect(html).toContain('&lt;script&gt;t&lt;/script&gt;');
  });

  it('keeps line breaks in the body', () => {
    const { html } = render({ body: 'one\ntwo' });
    expect(html).toContain('one');
    expect(html).toMatch(/one[\s\S]*<br[\s\S]*two/);
  });

  it('puts the store location and the request Unsubscribe link in the footer', () => {
    const url = 'https://shop.example.com/unsubscribe?t=abc';
    const { html } = render({ unsubscribeUrl: url });
    expect(html).toContain('Antipolo');
    expect(html).toContain(`<a href="${url}"`);
    expect(html).toMatch(/>Unsubscribe<\/a>/);
  });

  it('still accepts a request with no unsubscribeUrl', () => {
    const { html } = render({});
    expect(html).toContain('Antipolo');
    expect(html).not.toContain('Unsubscribe');
  });

  it('rejects an unsubscribeUrl that is not https', () => {
    expect(
      marketing.schema.safeParse({
        title: 't',
        body: 'b',
        unsubscribeUrl: 'http://x.example.com',
      }).success,
    ).toBe(false);
  });
});
