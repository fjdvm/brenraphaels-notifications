# Notifications

A backend service shared by the Portal, CRMS, POS, SIMS and HRMS apps. It delivers real-time in-app notifications, sends emails, and relays conversations between two apps. It has no frontend of its own.

## Language

**App**:
One of the systems that uses this service. For now only the ecommerce app and CRMS call it, and they share one database. Each App owns its own frontend and its own data.
_Avoid_: Client, tenant, system

**App email**:
A system Email an App sends to a person, built from one generic template (a title, body text and an optional button with a link). Verification and password reset are not App emails: the authentication service sends those. It needs no marketing consent.
_Avoid_: Transactional email, system mail

**Marketing email**:
A promotional Email that only CRMS can send, and only to Subscribers.
_Avoid_: Campaign, newsletter, blast

**Email template**:
A layout owned by this service that an Email is built from, so all Apps send branded mail the same way. There are two: the generic App email and marketing. The marketing template is universal: Staff supply only images, a title and text.
_Avoid_: Layout, theme

**Subscriber**:
A Customer who has opted in to marketing email. Marketing emails go only to Subscribers, to one or to many at a time. For now the ecommerce app owns the list of Subscribers and the caller sends only Subscribers. This service may take over the list later.
_Avoid_: Recipient list, mailing list member

**Notification**:
A real-time in-app message sent from one App to a user in another (or the same) App. It is stored, so a user who was offline still sees it later, and it can be marked read.
_Avoid_: Alert, push, event

**Email**:
A message sent to an address through Brevo, with a stored record of what was sent and its outcome.
_Avoid_: Mail, message

**Conversation**:
The live two-way exchange within one Ticket, between its Customer (in the ecommerce app) and the Staff who claimed it (in CRMS). The service only relays it and never stores it; each App keeps its own copy. A message for someone who is not connected is not held, and the sending App may send a Notification instead.
_Avoid_: Chat, thread, messaging

**Ticket**:
A support request opened by a Customer. A Customer can have many Tickets, and each Ticket has exactly one Conversation, with one Staff who claims it. A Ticket can be unclaimed, claimed, cancelled or completed, and only the Customer can cancel or complete it. Tickets belong to the Apps' shared database, not to this service.
_Avoid_: Case, issue, thread

**Customer**:
A person using the ecommerce app. One side of a Conversation.
_Avoid_: Client, buyer

**Staff**:
A person using CRMS on the business side. The other side of a Conversation.
_Avoid_: Agent, employee, admin
