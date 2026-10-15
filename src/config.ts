import { z } from 'zod';

const configSchema = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  DATABASE_URL: z.string().url(),
  APP_EMAIL_SENDER: z.string().email(),
  APP_EMAIL_SENDER_NAME: z.string().min(1).optional(),
  API_TOKEN: z.string().min(16),
  // Lets a retry ask Brevo whether an earlier, unconfirmed send went through.
  BREVO_API_KEY: z.string().min(1).optional(),
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
  SMTP_HOST: string;
  SMTP_PORT: string | number;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  DATABASE_URL: string;
  APP_EMAIL_SENDER: string;
  APP_EMAIL_SENDER_NAME?: string;
  API_TOKEN: string;
  BREVO_API_KEY?: string;
  EMAIL_QUEUE: Queue<EmailJob>;
}

export interface EmailJob {
  emailId: string;
}
