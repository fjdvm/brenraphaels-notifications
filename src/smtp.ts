import { WorkerMailer } from 'worker-mailer';
import type { Config } from './config';

export interface OutgoingMessage {
  sender: string;
  senderName?: string;
  to: string;
  subject: string;
  html: string;
}

/**
 * Sends one message over SMTP and returns its Message-ID. SMTP gives no
 * server-side id, so we generate one; the relay preserves it, which makes the
 * Email traceable in the relay's logs.
 */
export async function sendViaSmtp(
  config: Config,
  message: OutgoingMessage,
): Promise<string> {
  const messageId = `<${crypto.randomUUID()}@${message.sender.split('@').pop()}>`;
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
      headers: { 'Message-ID': messageId },
    },
  );
  return messageId;
}
