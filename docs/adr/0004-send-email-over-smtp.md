# Send email over Brevo's SMTP relay, not its HTTP API

Supersedes the "Brevo's HTTP API instead of SMTP" part of ADR-0002. The owner chose to use the Brevo SMTP credentials they already have. Workers can open outbound TCP sockets (`cloudflare:sockets`) on port 587 with STARTTLS, so we send through `worker-mailer`.

Consequences: SMTP returns no server-side message id, so the service generates a `Message-ID` header itself and stores it on the Email record; the relay preserves it. Tests stub the `worker-mailer` module, since `cloudflare:sockets` only exists inside Workers. Port 25 is blocked on Cloudflare, so use 587 (or 465 for implicit TLS).

Retries and idempotency: the Message-ID is generated when the Email is queued and reused by every attempt, so it is the idempotency key. SMTP replies are classified by code: 4xx and no reply at all (timeout, dropped socket) are temporary; 5xx are permanent, except 530/534/535 (our credentials), which stay temporary so Emails survive until they are fixed. Before each retry the service asks Brevo's events API whether it already has that Message-ID, and marks the Email sent instead of resending. That check needs the optional `BREVO_API_KEY` secret; without it a retry after an unknown outcome may send twice (with the same Message-ID).
