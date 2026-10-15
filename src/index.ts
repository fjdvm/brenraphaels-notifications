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
        await deliverEmail(db, config, message.body.emailId);
        message.ack();
      }
    } finally {
      await close();
    }
  },
} satisfies ExportedHandler<Env, EmailJob>;
