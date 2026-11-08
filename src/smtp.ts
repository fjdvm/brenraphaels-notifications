import nodemailer from 'nodemailer';
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
  const transport = nodemailer.createTransport({
    pool: true,
    maxConnections: 1,
    maxMessages: 1,
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    requireTLS: config.SMTP_PORT !== 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Timed out waiting for the SMTP relay'));
      transport.close({ force: true });
    }, SEND_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      transport.sendMail({
        from: message.senderName
          ? { name: message.senderName, address: message.sender }
          : message.sender,
        to: message.to,
        subject: message.subject,
        html: message.html,
        messageId: message.messageId,
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}
