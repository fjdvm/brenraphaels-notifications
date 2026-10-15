import type { Env } from '../config';
import type { Role } from './schemas';

/** Attaches a connection to a Ticket's room. */
export function connectToRoom(
  env: Env,
  ticketId: string,
  who: { userId: string; role: Role },
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
