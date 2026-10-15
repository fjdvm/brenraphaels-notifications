import { z } from 'zod';
import type { Env } from '../config';
import type { LiveEvent } from '../notifications/schemas';

const pushResult = z.object({ connected: z.number().int().nonnegative() });

const hubFor = (env: Env, app: string, userId: string) =>
  env.NOTIFICATION_HUB.get(
    env.NOTIFICATION_HUB.idFromName(JSON.stringify([app, userId])),
  );

/**
 * Pushes an event to every open connection of a user in an App. Returns how
 * many it reached. A failed push is logged and counts as none: the
 * Notification is already stored, so the user still sees it later.
 */
export async function pushToUser(
  env: Env,
  app: string,
  userId: string,
  event: LiveEvent,
): Promise<number> {
  try {
    const res = await hubFor(env, app, userId).fetch('http://hub/push', {
      method: 'POST',
      body: JSON.stringify(event),
    });
    return pushResult.parse(await res.json()).connected;
  } catch (err) {
    console.error(err);
    return 0;
  }
}

export function connectToHub(
  env: Env,
  app: string,
  userId: string,
  request: Request,
) {
  return hubFor(env, app, userId).fetch(
    new Request('http://hub/connect', request),
  );
}

/** Attaches a connection to a Ticket's room. */
export function connectToRoom(
  env: Env,
  ticketId: string,
  who: { userId: string; role: string },
  request: Request,
) {
  const room = env.CONVERSATION_ROOM.get(
    env.CONVERSATION_ROOM.idFromName(ticketId),
  );
  const url = new URL('http://room/connect');
  url.searchParams.set('userId', who.userId);
  url.searchParams.set('role', who.role);
  return room.fetch(new Request(url, request));
}
