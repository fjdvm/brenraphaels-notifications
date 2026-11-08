import nodemailer from 'nodemailer';
import { SEND_TIMEOUT_MS } from '../smtp';

/** Compatibility boundary for the existing delivery service during the Node migration. */
export const WorkerMailer = {
  async send(
    options: {
      host: string;
      port: number;
      secure: boolean;
      startTls: boolean;
      credentials: { username: string; password: string };
    },
    message: {
      from: string | { name: string; email: string };
      to: string;
      subject: string;
      html: string;
      headers: Record<string, string>;
    },
  ) {
    const transport = nodemailer.createTransport({
      pool: true,
      maxConnections: 1,
      maxMessages: 1,
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: options.startTls,
      auth: {
        user: options.credentials.username,
        pass: options.credentials.password,
      },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 30_000,
    });
    // The delivery deadline must also close the socket, not only reject its caller.
    const deadline = setTimeout(
      () => transport.close({ force: true }),
      SEND_TIMEOUT_MS,
    );
    try {
      await transport.sendMail({
        ...message,
        from:
          typeof message.from === 'string'
            ? message.from
            : {
                name: message.from.name,
                address: message.from.email,
              },
        messageId: message.headers['Message-ID'],
      });
    } finally {
      clearTimeout(deadline);
      transport.close();
    }
  },
};
