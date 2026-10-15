import { vi } from 'vitest';

// worker-mailer needs `cloudflare:sockets`, which only exists in Workers.
// The SMTP wire is the one boundary we stub; everything else runs for real.
vi.mock('worker-mailer', async () => {
  const { send } = await import('./smtp-stub');
  return { WorkerMailer: { send } };
});
