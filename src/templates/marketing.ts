import { z } from 'zod';
import { defineTemplate } from './define';
import { esc } from './escape';

export const marketing = defineTemplate({
  name: 'marketing',
  category: 'marketing',
  schema: z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    images: z.array(z.url({ protocol: /^https$/ })).default([]),
  }),
  render({ title, body, images }) {
    const imgs = images
      .map(
        (src) => `<p><img src="${esc(src)}" alt="" style="max-width:100%"></p>`,
      )
      .join('');
    return {
      subject: title,
      html: `<h1>${esc(title)}</h1>${imgs}<p>${esc(body)}</p>`,
    };
  },
});
