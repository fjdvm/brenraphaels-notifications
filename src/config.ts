import { z } from 'zod';

const configSchema = z.object({
  BREVO_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),
  APP_EMAIL_SENDER: z.string().email(),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env: Record<string, unknown>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return result.data;
}

export interface Env extends Record<string, unknown> {
  BREVO_API_KEY: string;
  DATABASE_URL: string;
  APP_EMAIL_SENDER: string;
  EMAIL_QUEUE: Queue<EmailJob>;
}

export interface EmailJob {
  emailId: string;
}
