# Send email over Brevo's SMTP relay, not its HTTP API

Supersedes the "Brevo's HTTP API instead of SMTP" part of ADR-0002. The owner chose to use the Brevo SMTP credentials they already have. Workers can open outbound TCP sockets (`cloudflare:sockets`) on port 587 with STARTTLS, so we send through `worker-mailer`.

Consequences: SMTP returns no server-side message id, so the service generates a `Message-ID` header itself and stores it on the Email record; the relay preserves it. Tests stub the `worker-mailer` module, since `cloudflare:sockets` only exists inside Workers. Port 25 is blocked on Cloudflare, so use 587 (or 465 for implicit TLS).
