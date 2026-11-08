import { vi } from 'vitest';

// Stub only the Node SMTP client; delivery and persistence run for real.
vi.mock('nodemailer', async () => {
  const { send, smtp } = await import('./smtp-stub');
  return {
    default: {
      createTransport: (options: unknown) => ({
        sendMail: (email: unknown) => send(options, email),
        close: (options?: { force?: boolean }) => smtp.closes.push(options),
      }),
    },
  };
});
