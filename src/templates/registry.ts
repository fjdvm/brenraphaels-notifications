import { appEmail } from './app-email';
import type { EmailTemplate } from './define';
import { marketing } from './marketing';

export const templates: Record<string, EmailTemplate> = {
  [appEmail.name]: appEmail as EmailTemplate,
  [marketing.name]: marketing as EmailTemplate,
};
