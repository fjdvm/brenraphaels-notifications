import { z } from 'zod';
import { defineTemplate } from './define';
import { esc } from './escape';
import { IMAGE_LAYOUTS, renderImages } from './image-layouts';

const PRIMARY = '#452175';
const INK = '#2b1b45';
const BODY = '#4b4458';
const MUTED = '#7d7590';
const LAVENDER = '#f4eefc';
const LINE = '#e4ddec';
const SERIF = "'Libre Baskerville', Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

const LOGO = 'https://brenraphaels.vercel.app/logo.jpeg';
const STORE_NAME = "Bren Raphael's";
const TAGLINE = 'A Taste of Heritage, A Spoonful of Love';
const STORE_ADDRESS =
  'Block 14 Lot 1A, Marigman Street, San Roque, Antipolo, Rizal, 1870 Antipolo PH-RIZ, Philippines';

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 18px;font-family:${SANS};font-size:16px;line-height:1.7;color:${BODY}">${esc(p.trim()).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');

export const marketing = defineTemplate({
  name: 'marketing',
  category: 'marketing',
  schema: z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    images: z.array(z.url({ protocol: /^https$/ })).default([]),
    imageLayout: z.enum(IMAGE_LAYOUTS).optional(),
    unsubscribeUrl: z.url({ protocol: /^https$/ }).optional(),
  }),
  render({ title, body, images, imageLayout, unsubscribeUrl }) {
    const imgs = renderImages(images, imageLayout);
    const unsubscribe = unsubscribeUrl
      ? `<p style="margin:12px 0 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED}">You are receiving this because you opted in to marketing emails. <a href="${esc(unsubscribeUrl)}" style="color:${PRIMARY};text-decoration:underline">Unsubscribe</a></p>`
      : '';
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${LAVENDER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${LAVENDER}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td align="center" style="background:${PRIMARY};padding:28px 24px">
<img src="${LOGO}" alt="${esc(STORE_NAME)}" width="72" height="72" style="display:block;width:72px;height:72px;border:0;border-radius:36px;margin:0 auto 12px">
<div style="font-family:${SERIF};font-size:22px;line-height:1.3;color:#ffffff;letter-spacing:0.5px">${esc(STORE_NAME)}</div>
<div style="font-family:${SERIF};font-style:italic;font-size:13px;line-height:1.4;color:#d7baff;margin-top:4px">${esc(TAGLINE)}</div>
</td></tr>
<tr><td style="padding:36px 24px 12px">
<h1 style="margin:0 0 24px;font-family:${SERIF};font-weight:normal;font-size:30px;line-height:1.25;color:${INK};text-align:center">${esc(title)}</h1>
<div style="width:48px;height:2px;background:#c9a8f0;margin:0 auto 28px"></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${imgs}</table>
${paragraphs(body)}
</td></tr>
<tr><td style="padding:12px 24px 36px"><div style="border-top:1px solid ${LINE}"></div></td></tr>
<tr><td align="center" style="background:${LAVENDER};padding:28px 24px">
<div style="font-family:${SERIF};font-size:15px;color:${PRIMARY}">${esc(STORE_NAME)}</div>
<p style="margin:8px 0 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED}">${esc(STORE_ADDRESS)}</p>
${unsubscribe}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
    return { subject: title, html };
  },
});
