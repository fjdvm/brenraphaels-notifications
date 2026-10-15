import type { z } from 'zod';

export interface EmailTemplate<S extends z.ZodType = z.ZodType> {
  name: string;
  category: 'app' | 'marketing';
  schema: S;
  render(values: z.infer<S>): { subject: string; html: string };
}

export function defineTemplate<S extends z.ZodType>(
  t: EmailTemplate<S>,
): EmailTemplate<S> {
  return t;
}
