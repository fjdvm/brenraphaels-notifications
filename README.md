# Notifications

Hono Worker on Cloudflare (see `docs/adr/`). Email goes through Brevo's HTTP API via a Cloudflare Queue; records live in Neon through Drizzle.

## Setup

```bash
npm install
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put DATABASE_URL
```

`APP_EMAIL_SENDER` is a var in `wrangler.jsonc`. Apply migrations with `npx drizzle-kit migrate` (needs `DATABASE_URL`).

## Endpoints

- `POST /emails/app` `{ to, app, title, body, button?: { label, link } }` → `202 { id, status: "queued" }`
- `GET /emails/:id` → the Email record (status, attempts, Brevo message id, failure reason)

## Tests

Tests drive the Worker's `fetch` and `queue` handlers with Brevo stubbed against a real Postgres.

```bash
docker run -d -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
npm test   # TEST_DATABASE_URL overrides the default postgres://postgres:test@localhost:54329/postgres
```
