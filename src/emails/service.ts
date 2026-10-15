import { eq } from 'drizzle-orm';
import { sendViaBrevo } from '../brevo';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { emails } from '../db/schema';
import { templates } from '../templates/registry';

// Sender address per category; marketing arrives with its own ticket.
const senderFor = (config: Config, category: 'app' | 'marketing') => {
  if (category === 'app') return config.APP_EMAIL_SENDER;
  throw new Error(`No sender configured for category ${category}`);
};

export async function createEmail(
  db: Db,
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
    })
    .returning();
  return row!;
}

export async function getEmail(db: Db, id: string) {
  const [row] = await db.select().from(emails).where(eq(emails.id, id));
  return row;
}

export async function deliverEmail(db: Db, config: Config, id: string) {
  const email = await getEmail(db, id);
  if (!email || email.status !== 'queued') return;
  try {
    const template = templates[email.template];
    if (!template) throw new Error(`Unknown template ${email.template}`);
    const { subject, html } = template.render(JSON.parse(email.values));
    const messageId = await sendViaBrevo(config.BREVO_API_KEY, {
      sender: senderFor(config, email.category),
      to: email.recipient,
      subject,
      html,
    });
    await db
      .update(emails)
      .set({
        status: 'sent',
        brevoMessageId: messageId,
        attempts: email.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(emails.id, id));
  } catch (err) {
    await db
      .update(emails)
      .set({
        status: 'failed',
        failureReason: err instanceof Error ? err.message : String(err),
        attempts: email.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(emails.id, id));
  }
}
