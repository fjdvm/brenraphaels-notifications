import { WorkerMailer } from 'worker-mailer';
import type { Config } from './config';

export interface OutgoingMessage {
  /** Idempotency key: stable across retries, so a recipient can spot a duplicate. */
  messageId: string;
  sender: string;
  senderName?: string;
  to: string;
  subject: string;
  html: string;
}

export const SEND_TIMEOUT_MS = 30_000;

/** SMTP gives no server-side id, so each Email carries a generated Message-ID the relay preserves. */
export const newMessageId = (sender: string) =>
  `<${crypto.randomUUID()}@${sender.split('@').pop()}>`;

/** Sends one message over SMTP; throws if the relay did not confirm it. */
export async function sendViaSmtp(
  config: Config,
  message: OutgoingMessage,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Timed out waiting for the SMTP relay')),
      SEND_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([sendOnce(config, message), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendOnce(config: Config, message: OutgoingMessage) {
  await WorkerMailer.send(
    {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      startTls: config.SMTP_PORT !== 465,
      authType: 'plain',
      credentials: {
        username: config.SMTP_USER,
        password: config.SMTP_PASSWORD,
      },
    },
    {
      from: message.senderName
        ? { name: message.senderName, email: message.sender }
        : message.sender,
      to: message.to,
      subject: message.subject,
      html: message.html,
      headers: { 'Message-ID': message.messageId },
    },
  );
}
