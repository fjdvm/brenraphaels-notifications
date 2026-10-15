# Hono instead of NestJS

The initial scaffold was NestJS (Express, Socket.IO, BullMQ), which doesn't fit the Cloudflare Workers runtime chosen in ADR-0001. We rewrite on Hono, with Durable Objects for WebSockets and (initially) Brevo's HTTP API instead of SMTP; see ADR-0004, which switches to SMTP. The scaffold had no real logic yet, so the rewrite was cheap.
