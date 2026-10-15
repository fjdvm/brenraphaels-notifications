import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { emails } from '../db/schema';
import { newMessageId, relayHasMessage, sendViaSmtp } from '../smtp';
import { templates } from '../templates/registry';
import {
  PermanentFailure,
  RETRY_WINDOW_MS,
  classifyFailure,
  retryDelaySeconds,
} from './retry';

// Sender address per category; marketing arrives with its own ticket.
const senderFor = (config: Config, category: 'app' | 'marketing') => {
  if (category === 'app') return config.APP_EMAIL_SENDER;
  throw new Error(`No sender configured for category ${category}`);
};

export async function createEmail(
  db: Db,
  config: Config,
  input: {
    template: string;
    recipient: string;
    sendingApp: string;
    values: unknown;
  },
) {
  const [row] = await db
    .insert(emails)
    .values({
      category: templates[input.template]!.category,
      template: input.template,
      recipient: input.recipient,
      sendingApp: input.sendingApp,
      values: JSON.stringify(input.values),
      status: 'queued',
      messageId: newMessageId(
        senderFor(config, templates[input.template]!.category),
      ),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return row!;
}

export async function getEmail(db: Db, id: string) {
  const [row] = await db.select().from(emails).where(eq(emails.id, id));
  return row;
}

async function update(
  db: Db,
  id: string,
  set: Partial<typeof emails.$inferInsert>,
) {
  await db
    .update(emails)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(emails.id, id));
}

const markFailed = (db: Db, id: string, attempts: number, reason: string) =>
  update(db, id, { status: 'failed', failureReason: reason, attempts });

const markSent = (db: Db, id: string, attempts: number) =>
  update(db, id, { status: 'sent', failureReason: null, attempts });

export async function markEnqueueFailed(db: Db, id: string, err: unknown) {
  const email = await getEmail(db, id);
  if (email)
    await markFailed(
      db,
      id,
      email.attempts + 1,
      `Could not queue: ${err instanceof Error ? err.message : String(err)}`,
    );
}

export interface Delivery {
  /** Set when the Email stays queued and should be tried again after this long. */
  retryInSeconds?: number;
}

export async function deliverEmail(
  db: Db,
  config: Config,
  id: string,
): Promise<Delivery> {
  const email = await getEmail(db, id);
  if (!email || email.status !== 'queued') return {};

  // Rows queued before Message-IDs were assigned at creation have none yet.
  let messageId = email.messageId;
  if (!messageId) {
    messageId = newMessageId(senderFor(config, email.category));
    await db.update(emails).set({ messageId }).where(eq(emails.id, email.id));
  }

  // An earlier attempt may have been accepted without us hearing; don't send twice.
  if (email.attempts > 0 && (await relayHasMessage(config, messageId))) {
    await markSent(db, id, email.attempts);
    return {};
  }

  // Recorded before sending, so a crash after the relay accepts still leaves
  // the Email looking attempted and the next delivery runs the check above.
  const attempts = email.attempts + 1;
  await update(db, id, { attempts });

  try {
    const template = templates[email.template];
    if (!template)
      throw new PermanentFailure(`Unknown template ${email.template}`);
    let content;
    try {
      content = template.render(JSON.parse(email.values));
    } catch (err) {
      throw new PermanentFailure(
        `Could not render: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sendViaSmtp(config, {
      messageId,
      sender: senderFor(config, email.category),
      senderName: config.APP_EMAIL_SENDER_NAME,
      to: email.recipient,
      subject: content.subject,
      html: content.html,
    });
  } catch (err) {
    const failure = classifyFailure(err);
    const remainingMs =
      email.createdAt.getTime() + RETRY_WINDOW_MS - Date.now();
    if (failure.kind === 'permanent' || remainingMs <= 0) {
      await markFailed(db, id, attempts, failure.reason);
      return {};
    }
    await update(db, id, { failureReason: failure.reason });
    // The last retry lands on the deadline, so the Email fails on time.
    return {
      retryInSeconds: Math.min(
        retryDelaySeconds(attempts),
        Math.ceil(remainingMs / 1000),
      ),
    };
  }

  // Outside the try: a database error here must not mark a delivered Email as failed.
  await markSent(db, id, attempts);
  return {};
}
