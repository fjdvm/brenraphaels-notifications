# Conversations are relayed, never stored

The ecommerce app and CRMS already keep their own copy of every Conversation message, so this service only passes messages between connected people, keyed by ticket ID. A message for someone who is offline is dropped here, and the App covers the gap by saving it and sending a Notification. This keeps one source of truth for message history and keeps this service free of Ticket and message data.
