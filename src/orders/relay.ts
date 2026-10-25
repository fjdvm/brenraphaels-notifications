import type { Env } from '../config';
import type { z } from 'zod';
import type { orderEvent } from './schemas';

const hubFor = (env: Env, customerId: string) =>
  env.ORDER_HUB.get(env.ORDER_HUB.idFromName(customerId));

export function connectToOrders(
  env: Env,
  customerId: string,
  request: Request,
) {
  return hubFor(env, customerId).fetch(
    new Request('http://hub/connect', request),
  );
}

export function publishToOrders(
  env: Env,
  customerId: string,
  event: z.infer<typeof orderEvent>,
) {
  return hubFor(env, customerId).fetch('http://hub/push', {
    method: 'POST',
    body: JSON.stringify(event),
  });
}
