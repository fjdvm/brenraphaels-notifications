# Deploy entirely on Cloudflare, not Vercel

Status: superseded by [ADR-0005](0005-single-instance-node-runtime-on-azure-container-apps.md).

The notification service needs persistent WebSockets, which Vercel functions can't hold. Rather than split across Vercel and a second host, the whole service runs on Cloudflare (Workers, with Durable Objects for sockets), with Neon as the database.

Deploys happen from GitHub Actions: every push to `main` runs the tests, applies Neon migrations, and runs `wrangler deploy` (see the README's CI/CD section).
