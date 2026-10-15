import { app } from './app';
import { parseConfig, type EmailJob, type Env } from './config';
import { createDb } from './db/client';
import { deliverEmail } from './emails/service';

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<EmailJob>, env: Env) {
    const config = parseConfig(env);
    const { db, close } = createDb(config.DATABASE_URL);
    try {
      for (const message of batch.messages) {
        try {
          await deliverEmail(db, config, message.body.emailId);
          message.ack();
        } catch (err) {
          // Delivery is idempotent (only `queued` Emails are sent), so retrying is safe.
          console.error(err);
          message.retry();
        }
      }
    } finally {
      await close();
    }
  },
} satisfies ExportedHandler<Env, EmailJob>;
