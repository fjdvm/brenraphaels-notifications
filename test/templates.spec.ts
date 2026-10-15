import { describe, expect, it } from 'vitest';
import { templates } from '../src/templates/registry';

describe('template registry', () => {
  it('has every template declare its own zod schema and category', () => {
    for (const t of Object.values(templates)) {
      expect(typeof t.schema.safeParse).toBe('function');
      expect(['app', 'marketing']).toContain(t.category);
    }
    expect(templates['app-email']).toBeDefined();
  });
});
