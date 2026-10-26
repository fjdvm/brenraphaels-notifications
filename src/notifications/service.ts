import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { notifications } from '../db/schema';

export interface NewNotification {
  idempotencyKey?: string;
  type: string;
  title: string;
  body: string;
  link?: string;
  sendingApp: string;
  targetApp: string;
  userIds: string[];
}

export async function createNotifications(db: Db, input: NewNotification) {
  const { userIds, link, ...rest } = input;
  const createdAt = new Date();
  // One row per distinct recipient.
  return db
    .insert(notifications)
    .values(
      [...new Set(userIds)].map((userId) => ({
        ...rest,
        link: link ?? null,
        userId,
        createdAt,
      })),
    )
    .onConflictDoNothing()
    .returning();
}

const encodeCursor = (row: { createdAt: Date; id: string }) =>
  btoa(`${row.createdAt.toISOString()}|${row.id}`);

function decodeCursor(cursor: string) {
  try {
    const [iso, id] = atob(cursor).split('|');
    const createdAt = new Date(iso ?? '');
    if (!id || Number.isNaN(createdAt.getTime())) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

/** Newest first. The cursor is a position, so new arrivals never shift a page. */
export async function listNotifications(
  db: Db,
  q: {
    userId: string;
    app: string;
    unreadOnly: boolean;
    limit: number;
    cursor?: string;
  },
) {
  const after = q.cursor ? decodeCursor(q.cursor) : undefined;
  if (q.cursor && !after) return undefined;
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, q.userId),
        eq(notifications.targetApp, q.app),
        q.unreadOnly ? isNull(notifications.readAt) : undefined,
        after
          ? or(
              lt(notifications.createdAt, after.createdAt),
              and(
                eq(notifications.createdAt, after.createdAt),
                lt(notifications.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit);
  return {
    items,
    nextCursor:
      rows.length > q.limit ? encodeCursor(items[items.length - 1]!) : null,
  };
}

export async function countUnread(db: Db, userId: string, app: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.targetApp, app),
        isNull(notifications.readAt),
      ),
    );
  return row!.n;
}

/**
 * `found` is false when the user has no such Notification in that App;
 * `changed` is false when it was already read.
 */
export async function markRead(
  db: Db,
  id: string,
  userId: string,
  app: string,
) {
  const owned = and(
    eq(notifications.id, id),
    eq(notifications.userId, userId),
    eq(notifications.targetApp, app),
  );
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(owned, isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  if (updated.length > 0) return { found: true, changed: true };
  const found = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(owned);
  return { found: found.length > 0, changed: false };
}

/** Returns the ids that were unread and are now read. */
export async function markAllRead(db: Db, userId: string, app: string) {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.targetApp, app),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return rows.map((r) => r.id);
}
