# Notifications

Hono Worker on Cloudflare (see `docs/adr/`), deployed as `br-notifications` at https://br-notifications.jude-nitram08.workers.dev. Email goes through Brevo's SMTP relay (ADR-0004) via a Cloudflare Queue; records live in Neon through Drizzle.

## Setup

```bash
npm install
npx wrangler secret put SMTP_USER
npx wrangler secret put SMTP_PASSWORD
npx wrangler secret put DATABASE_URL
npx wrangler secret put API_TOKEN
npx wrangler queues create notifications-email
npx wrangler deploy
```

`SMTP_HOST`, `SMTP_PORT`, `APP_EMAIL_SENDER` and `APP_EMAIL_SENDER_NAME` are vars in `wrangler.jsonc`. The sender must be verified in Brevo. Copy values into `.env` for local use (gitignored). Apply migrations with `npm run db:migrate` (reads `DATABASE_URL` from `.env`).

All `/emails/*` routes need `Authorization: Bearer <API_TOKEN>`.

## Endpoints

- `POST /emails/app` `{ to, app, title, body, button?: { label, link } }` → `202 { id, status: "queued" }`
- `GET /emails/:id` → the Email record (status, attempts, Message-ID, failure reason)

## Tests

Tests drive the Worker's `fetch` and `queue` handlers with the SMTP client stubbed against a real Postgres.

```bash
docker run -d -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
npm test   # TEST_DATABASE_URL overrides the default postgres://postgres:test@localhost:54329/postgres
```
