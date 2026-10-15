import { z } from 'zod';
import { defineTemplate } from './define';
import { esc } from './escape';

export const appEmail = defineTemplate({
  name: 'app-email',
  category: 'app',
  schema: z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    button: z
      .object({
        label: z.string().min(1),
        link: z.url({ protocol: /^https?$/ }),
      })
      .optional(),
  }),
  render({ title, body, button }) {
    const btn = button
      ? `<p><a href="${esc(button.link)}">${esc(button.label)}</a></p>`
      : '';
    return {
      subject: title,
      html: `<h1>${esc(title)}</h1><p>${esc(body)}</p>${btn}`,
    };
  },
});
