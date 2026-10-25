# Order and Return event relay

For fjdvm/epic-crms#229. The gateway authenticates Customers using a short-lived Order Live ticket. Only the storefront Caller (`systemCode: ECOM`) can request those passes or publish events through the gateway.

- `GET /orders/live?userId=<Customer>` requires `X-Gateway-Secret` and a WebSocket upgrade. The gateway supplies the verified Customer. Clients only listen (with the existing ping/pong keep-alive).
- `POST /orders/events` requires the service bearer token and `{ customerId, event }`. Events are `{ type: "order.updated", orderId }` or `{ type: "return.updated", orderId, returnId }`; unknown fields and invalid identifiers are refused.
- Every connected tab for that Customer receives the event. `{ connected }` counts sockets reached. No event is stored, queued or replayed; nothing is sent to the notification bell. Refetch Orders on connect and reconnect.

`ORDER_HUB` binds a separate `OrderHub` Durable Object namespace with migration v3. It reuses the existing hibernating push-only transport, without database access. Deploy this service before the gateway companion PR. Existing Notification and Conversation channels are unchanged.

Tests use the real Worker handler and relay with the existing fake Durable Object runtime. They cover Customer isolation, tabs, offline drops, no replay, listen-only sockets, authentication and invalid inputs. The gateway companion tests pass signing, expiry, forgery and channel isolation.

After both companions deploy, use the storefront Caller key to issue passes for two Customers through the gateway, connect both browsers, publish an Order and Return event for only one Customer, and confirm that only their socket receives them. Reconnect and verify there is no replay. The deployed check remains a post-merge acceptance step.
