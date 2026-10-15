# Deploy entirely on Cloudflare, not Vercel

The notification service needs persistent WebSockets, which Vercel functions can't hold. Rather than split across Vercel and a second host, the whole service runs on Cloudflare (Workers, with Durable Objects for sockets), with Neon as the database.
