import { z } from 'zod';

const configSchema = z.object({
  BREVO_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),
  APP_EMAIL_SENDER: z.string().email(),
  APP_EMAIL_SENDER_NAME: z.string().min(1).optional(),
  API_TOKEN: z.string().min(16),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export function parseConfig(env: Record<string, unknown>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  return result.data;
}

export interface Env extends Record<string, unknown> {
  BREVO_API_KEY: string;
  DATABASE_URL: string;
  APP_EMAIL_SENDER: string;
  APP_EMAIL_SENDER_NAME?: string;
  API_TOKEN: string;
  EMAIL_QUEUE: Queue<EmailJob>;
}

export interface EmailJob {
  emailId: string;
}
