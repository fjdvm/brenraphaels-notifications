# Send email over Brevo's SMTP relay, not its HTTP API

Status: partially superseded by [ADR-0005](0005-single-instance-node-runtime-on-azure-container-apps.md) for Workers sockets and worker-mailer. SMTP, retry classification, Message-ID reuse and at-least-once delivery remain in effect.

Supersedes the "Brevo's HTTP API instead of SMTP" part of ADR-0002. The owner chose to use the Brevo SMTP credentials they already have. Workers can open outbound TCP sockets (`cloudflare:sockets`) on port 587 with STARTTLS, so we send through `worker-mailer`.

Consequences: SMTP returns no server-side message id, so the service generates a `Message-ID` header itself and stores it on the Email record; the relay preserves it. Tests stub the `worker-mailer` module, since `cloudflare:sockets` only exists inside Workers. Port 25 is blocked on Cloudflare, so use 587 (or 465 for implicit TLS).

Retries and idempotency: the Message-ID is generated when the Email is queued and reused by every attempt, so it is the idempotency key. SMTP replies are classified by code: 4xx and no reply at all (timeout, dropped socket) are temporary; 5xx are permanent, except 530/534/535 (our credentials), which stay temporary so Emails survive until they are fixed. A temporary failure is retried with growing delays until 24 hours after queueing.

Duplicates: SMTP cannot tell us whether a timed-out send was accepted, and the only way to ask is Brevo's separate HTTP events API, which needs a second credential. The owner chose to use SMTP only. So delivery is at least once: after a timeout that Brevo had in fact accepted, the retry sends again, with the same Message-ID. This knowingly gives up the ticket's "never send twice" guarantee for that rare case.
