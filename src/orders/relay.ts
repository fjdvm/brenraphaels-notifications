import type { Env } from '../config';
import type { z } from 'zod';
import type { orderEvent, stockChanged } from './schemas';

const hubFor = (env: Env, customerId: string) =>
  env.ORDER_HUB.get(
    env.ORDER_HUB.idFromName(JSON.stringify(['customer', customerId])),
  );

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

// Staff and Customer namespaces cannot collide, even with a crafted user id.
const staffHub = (env: Env) =>
  env.ORDER_HUB.get(env.ORDER_HUB.idFromName(JSON.stringify(['staff'])));

export function connectToStaffOrders(env: Env, request: Request) {
  return staffHub(env).fetch(new Request('http://hub/connect', request));
}

export function publishStaffOrdersChanged(env: Env) {
  return staffHub(env).fetch('http://hub/push', {
    method: 'POST',
    body: JSON.stringify({ type: 'orders.changed' }),
  });
}

// A room of its own, so Staff stock sockets never share the Orders signal.
const stockHub = (env: Env) =>
  env.ORDER_HUB.get(env.ORDER_HUB.idFromName(JSON.stringify(['staff-stock'])));

export function connectToStaffStock(env: Env, request: Request) {
  return stockHub(env).fetch(new Request('http://hub/connect', request));
}

export function publishStaffStockChanged(env: Env, sizeId: string) {
  const event: z.infer<typeof stockChanged> = { type: 'stock.changed', sizeId };
  return stockHub(env).fetch('http://hub/push', {
    method: 'POST',
    body: JSON.stringify(event),
  });
}
