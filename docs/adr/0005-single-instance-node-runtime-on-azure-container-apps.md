# Run notifications as a single Node service on Azure Container Apps

Status: accepted; supersedes [ADR-0001](0001-deploy-entirely-on-cloudflare.md), the Cloudflare runtime and Durable Objects portions of [ADR-0002](0002-hono-instead-of-nestjs.md), and the Workers socket API and worker-mailer portions of [ADR-0004](0004-send-email-over-smtp.md). Hono, SMTP delivery, retry classification and at-least-once delivery remain the decisions. Implementation is tracked in [Spec#138](https://github.com/fjdvm/brenraphaels-authentication-microservice/issues/138); recorded by [Ticket#140](https://github.com/fjdvm/brenraphaels-authentication-microservice/issues/140).

The Portal's Vercel Hobby pause, available Azure credit (about $80, to be verified) and monthly budget below $20 motivate consolidating the Portal and shared services on Azure Container Apps. The shared hosting decision is recorded in the Portal's ADR-0002 and gateway's ADR-0002. For notifications, run the existing Hono application as one Node service with in-memory WebSocket rooms and timer-based Email retries, with no polling. This replaces Cloudflare Durable Objects and Queues while keeping Neon Postgres and the existing service behavior.

Conversation rooms remain keyed by Ticket; notification-hub and order-hub rooms keep their existing recipient keys. Every connected participant must reach the same process for these in-memory rooms to work. This is an architectural single-instance constraint; replica counts and resource sizing are tuning settings maintained in Spec#138 rather than a separate replica-policy ADR.

## Alternatives considered

Keep Workers, Durable Objects and Queues: this preserves distributed room coordination and managed retries, but retains Cloudflare alongside Azure and Vercel instead of consolidating within the Azure credit. Add Azure Web PubSub or Redis now: shared coordination would allow scale-out but adds infrastructure, cost and operating work that the current single-instance requirement does not justify. Poll for pending Emails or new Notifications: this repeatedly wakes the service and spends CPU while idle, contrary to the no-polling requirement.

## Consequences

The service cannot scale out safely without introducing shared coordination such as Azure Web PubSub or Redis. A process restart drops WebSocket connections and in-memory room membership; clients must reconnect automatically with backoff and rejoin. As [ADR-0003](0003-conversations-are-relayed-not-stored.md) already establishes, Conversations are relayed and never stored here: the Apps own message history and cover offline delivery. Restarting loses no stored Conversation history in this service, but an in-flight or offline relay can still be dropped; this does not introduce guaranteed delivery. Stored Notifications remain in Neon.

Each queued Email schedules a timer for its next due attempt. At startup, load pending Emails once from Neon and reschedule their timers, so a restart does not lose pending retries. No queue service, interval polling or periodic database scan is used. Temporary failures retain growing delays up to 24 hours after queueing; permanent failures stop immediately, with the existing credential-error exceptions retained. The Message-ID is generated at queueing and reused for every attempt. Delivery remains at least once: a timeout after SMTP acceptance can still produce a duplicate.

Use a standard Node SMTP client in place of Workers sockets and worker-mailer, keeping the Brevo SMTP relay and the existing Email contract. The accepted cost is rewriting the Cloudflare integrations and operating the container and its restart recovery. Azure credit and the below-$20 budget need verification and ongoing monitoring; consolidating hosts is not a cost guarantee.
