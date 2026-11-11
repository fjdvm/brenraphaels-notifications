import { defineConfig } from 'drizzle-kit';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the real environment (CI).
}

// Migrations use a direct Neon connection; runtime traffic keeps its pooler.
const migrationUrl = new URL(
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!,
);
if (migrationUrl.hostname.endsWith('.neon.tech')) {
  migrationUrl.hostname = migrationUrl.hostname.replace('-pooler.', '.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: migrationUrl.toString() },
});
