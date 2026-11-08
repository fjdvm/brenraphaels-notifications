# Hono instead of NestJS

Status: partially superseded by [ADR-0005](0005-single-instance-node-runtime-on-azure-container-apps.md) for the Cloudflare runtime and Durable Objects. The Hono decision remains in effect; ADR-0004 supersedes the original Email transport choice.

The initial scaffold was NestJS (Express, Socket.IO, BullMQ), which doesn't fit the Cloudflare Workers runtime chosen in ADR-0001. We rewrite on Hono, with Durable Objects for WebSockets and (initially) Brevo's HTTP API instead of SMTP; see ADR-0004, which switches to SMTP. The scaffold had no real logic yet, so the rewrite was cheap.
