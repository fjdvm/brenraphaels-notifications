import { appEmail } from './app-email';
import type { EmailTemplate } from './define';

export const templates: Record<string, EmailTemplate> = {
  [appEmail.name]: appEmail as EmailTemplate,
};
