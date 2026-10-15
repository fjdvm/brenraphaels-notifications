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

type EmailRow = NonNullable<Awaited<ReturnType<typeof getEmail>>>;

async function markFailed(
  db: Db,
  email: { id: string; attempts: number },
  reason: string,
) {
  await db
    .update(emails)
    .set({
      status: 'failed',
      failureReason: reason,
      attempts: email.attempts + 1,
      updatedAt: new Date(),
    })
    .where(eq(emails.id, email.id));
}

async function markSent(db: Db, email: EmailRow, attemptMade: boolean) {
  await db
    .update(emails)
    .set({
      status: 'sent',
      failureReason: null,
      attempts: email.attempts + (attemptMade ? 1 : 0),
      updatedAt: new Date(),
    })
    .where(eq(emails.id, email.id));
}

export async function markEnqueueFailed(db: Db, id: string, err: unknown) {
  const email = await getEmail(db, id);
  if (email)
    await markFailed(
      db,
      email,
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
    await markSent(db, email, false);
    return {};
  }

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
      messageId: messageId,
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
      await markFailed(db, email, failure.reason);
      return {};
    }
    const attempts = email.attempts + 1;
    await db
      .update(emails)
      .set({ attempts, failureReason: failure.reason, updatedAt: new Date() })
      .where(eq(emails.id, email.id));
    // The last retry lands on the deadline, so the Email fails on time.
    const seconds = Math.min(
      retryDelaySeconds(attempts),
      Math.ceil(remainingMs / 1000),
    );
    return { retryInSeconds: seconds };
  }

  // Outside the try: a database error here must not mark a delivered Email as failed.
  await markSent(db, email, true);
  return {};
}
