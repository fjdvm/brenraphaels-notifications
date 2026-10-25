import { z } from 'zod';

const id = z.string().min(1).max(128);
export const orderConnectQuery = z.object({ userId: id });

// Invalidation signals only: the storefront refetches its own authoritative data.
export const orderEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('order.updated'), orderId: id }).strict(),
  z
    .object({ type: z.literal('return.updated'), orderId: id, returnId: id })
    .strict(),
]);
export const publishOrderEvent = z
  .object({ customerId: id, event: orderEvent })
  .strict();
