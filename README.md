# Notifications

Hono HTTP service running on Node 24, packaged for Azure Container Apps (ADR-0005). REST routes, the docs page and stateless MCP keep the existing API contract. Records remain in Neon through Drizzle. The old Cloudflare deployment stays available during the staged cutover in Portal Spec#138.

## Setup

```bash
npm ci
cp .env.production.example .env
# Fill in .env with the existing database, SMTP and caller credentials.
npm run db:migrate
npm run dev
```

`npm run build` bundles the Node entrypoint and the HTML guide; `npm start` runs `node dist/server.mjs` with environment variables already supplied. `npm run dev` additionally reads `.env`. Missing or invalid configuration fails startup without printing secret values. `PORT` defaults to `8080`; the listener binds to `0.0.0.0`. Both sender addresses must be verified in Brevo.

`.env.production.example` lists required and optional runtime keys. `DATABASE_URL`, `SMTP_USER`, `SMTP_PASSWORD`, `API_TOKEN` and `GATEWAY_SECRET` are secrets. Existing keys and database records are unchanged. No new schema or data migration is required; `db:migrate` applies the existing migrations to a new database.

## Container

```bash
docker build -t notifications:local .
docker run --rm --env-file .env -p 8080:8080 notifications:local
```

The runtime runs as the unprivileged `node` user. No Workers runtime, Cloudflare bindings or Cloudflare credentials are needed. `GET /health` is unauthenticated and returns `200 {"status":"ok"}` after startup recovery succeeds. Configure the platform's HTTP probe on `/health` and its target port to match `PORT`. SIGTERM/SIGINT stop HTTP and live connections and allow active deliveries to finish, with a 35-second shutdown deadline.

Node adapters preserve the existing delivery and relay interfaces. Portal tickets #148–#150 cover live rooms, Node SMTP and timer-based Email retries. WebSocket rooms are in memory, so run exactly one replica; clients reconnect after restart. Each Email has one timer for its next due attempt, with delays of 30 seconds, 60 seconds, 2 minutes and so on, capped at one hour. Startup loads queued rows once and rebuilds timers from the last attempt time; overdue rows run immediately. At 24 hours from queueing, pending Emails are marked failed without opening SMTP again. The last SMTP failure reason is retained, and attempts count only actual delivery attempts. There is no queue service, interval polling or periodic database query while idle. Email delivery uses Nodemailer directly with required STARTTLS on port 587 (or implicit TLS on port 465). Each attempt carries the queued Message-ID and closes its SMTP connection on completion or the 30-second deadline. Tests stub Nodemailer without importing Workers socket modules. `src/index.ts` and `wrangler.jsonc` remain for rollback and those tests; production starts at `src/node/server.ts`.

## CI

`.github/workflows/deploy.yml` runs typecheck, lint and the existing tests. A separate job builds the Docker image, migrates a disposable Postgres database, starts the actual image with production-shaped environment variables and checks health, authentication, creating and reading one Notification, the docs and MCP. The job uses no production credentials. Re-run its HTTP checks with `SMOKE_URL=http://localhost:8080 API_TOKEN=... npm run smoke`.

`npm run smoke:live` exercises the running image over real HTTP/WebSocket connections: gateway-secret rejection on all three live routes, two-way Conversation relay, Ticket isolation, offline message drops, Notification push to all recipient tabs with App/user isolation, and Order event isolation. It then restarts the named container, waits for health, reconnects to the same Ticket without history and repeats delivery checks. No database inspection or polling for messages is used. Health polling only waits for startup; `ping`/`pong` provides a processing barrier when checking that an unrelated socket received nothing.

```bash
SMOKE_URL=http://localhost:8080 API_TOKEN=... GATEWAY_SECRET=... \
  SMOKE_CONTAINER=notifications-local npm run smoke:live
```

Use a disposable container and database: the script creates Notifications and restarts `SMOKE_CONTAINER` through the Docker CLI. CI runs it against its smoke container after the HTTP checks. Room state is ephemeral; Notifications remain stored, while Conversations and Order events have no replay. The gateway validates Live tickets before forwarding the existing `x-gateway-secret`; the service rejects absent or incorrect secrets before upgrading. Production requires exactly one replica. This ticket changes no schema and needs no production migration.

The workflow no longer deploys to Cloudflare or migrates the production database on merge. GHCR publication and Azure deployment are handled by the subsequent delivery ticket; the existing Worker is kept serving until cutover is verified.

## Endpoints

- `POST /emails/app` accepts optional `Idempotency-Key` (1–255 nonblank characters).
  The App, recipient and key identify one Email; retries return its original id
  and current status, preserving content and Message-ID. Concurrent deliveries
  of a keyed Email serialize. Failed queue submissions can be retried using the
  same key. Omit the header to create a new Email on every request.
- `POST /emails/app` `{ to, app, title, body, button?: { label, link } }` → `202 { id, status: "queued" }`
- `POST /emails/marketing` `{ to, app: "CRMS", subscriberConsent: true, title, body, images?: [https urls], imageLayout?: one of stacked | single | two-columns | two-rows | three-feature-left | three-feature-top | three-row | four-grid | four-feature-left | four-feature-top, unsubscribeUrl?: https url }` → `202 { id, status: "queued" }`
- `POST /emails/marketing/list` `{ recipients: [emails], app: "CRMS", subscriberConsent: true, title, body, images?, imageLayout?, unsubscribeUrl? }` → `202 { queued, emails: [{ id, recipient }] }`. One Email per distinct address (case-insensitive), queued independently. More than `MARKETING_MAX_RECIPIENTS` (optional var, default 100) → `400`.
- `GET /emails/:id` → the Email record (status, attempts, Message-ID, failure reason)

## Docs and agents

- `GET /docs`: the usage guide, with a worked example per route. Hand-written in `src/docs/guide.html`; `test/docs.spec.ts` fails if a route in `src/docs/contract.ts` is missing from it.
- `GET /openapi.json`: OpenAPI 3.1, generated from `src/docs/contract.ts` and the `schemas.ts` files in `src/notifications/` and `src/emails/`. A test fails when the app and the contract disagree. Add a route to the contract when you add it to the app.
- `POST /mcp`: stateless remote MCP server for agents, behind the same bearer token. Each tool in `src/mcp/tools.ts` calls the matching route in-process, so it validates and fails exactly like the API. Add a tool there when a route should be reachable from agents, and keep the "Use it from an agent" section of the guide in step.

`/docs` and `/openapi.json` need no token.

## Tests

The existing tests drive the legacy `fetch` and `queue` handlers with the SMTP client stubbed against a real Postgres. `test/email-timers.spec.ts` also drives the HTTP routes with the production Node scheduler and fake timers, covering growing delays, the one-hour cap, restart recovery, duplicate keyed submissions, expiry and zero idle database queries.

```bash
docker run -d -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
npm test   # TEST_DATABASE_URL overrides the default postgres://postgres:test@localhost:54329/postgres
```

`npm run smoke:email` verifies a running container against a local SMTP fixture that replies `421`: an Email stays queued, survives `docker restart`, and retries once at its original 30-second due time. CI starts the container with `SMTP_HOST=127.0.0.1`, `SMTP_PORT=18088` and host networking; set `SMOKE_CONTAINER` to its name and `SMOKE_URL` to its HTTP address. This uses only the disposable CI database and fixture relay.
