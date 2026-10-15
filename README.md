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

## CI/CD

`.github/workflows/deploy.yml` runs typecheck, lint and tests on every push and pull request. Every push to `main` (including a merged pull request) then applies migrations and runs `wrangler deploy`, only if the tests pass. The Worker's own secrets (SMTP, `DATABASE_URL`, `API_TOKEN`) stay in Cloudflare (`wrangler secret put`); the workflow needs three GitHub repository secrets:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard, My Profile, API Tokens, Create Token, template **Edit Cloudflare Workers**, set Account Resources to this account. Queues are used, so also add Account, Cloudflare Queues, Edit. Copy it once; it is not shown again. |
| `CLOUDFLARE_ACCOUNT_ID` | `npx wrangler whoami` prints it, or the dashboard's Workers & Pages overview (right-hand side). |
| `DATABASE_URL` | The same Neon connection string as in `.env` (Neon console, the project's Connect dialog, direct connection). Used only to apply migrations. |

Set them with the GitHub CLI so nothing is pasted into a page (each command prompts for the value; the last reads it from `.env`):

```sh
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set DATABASE_URL --body "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
```

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
