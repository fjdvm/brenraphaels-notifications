/** Email request shapes, shared by the routes, the OpenAPI document and the MCP tools. */
import { z } from 'zod';
import { appEmail } from '../templates/app-email';
import { marketing } from '../templates/marketing';

export const appEmailRequest = z.object({
  to: z.email(),
  app: z.string().min(1),
  ...appEmail.schema.shape,
});

export const marketingEmailRequest = z.object({
  to: z.email(),
  // A declared check only; real caller identity waits for authentication.
  app: z.literal('CRMS', { error: 'Only CRMS may send Marketing email' }),
  subscriberConsent: z.literal(true, {
    error: 'Must assert that the recipient is a Subscriber',
  }),
  ...marketing.schema.shape,
});

export const marketingListRequest = (max: number) => {
  const { to: _to, ...single } = marketingEmailRequest.shape;
  return z.object({
    ...single,
    recipients: z
      .array(z.email())
      .min(1, 'Needs at least one recipient')
      .max(max, `Too many recipients: the maximum is ${max}`),
  });
};
