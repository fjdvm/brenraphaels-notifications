export interface BrevoMessage {
  sender: string;
  to: string;
  subject: string;
  html: string;
}

export async function sendViaBrevo(
  apiKey: string,
  message: BrevoMessage,
): Promise<string> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: message.sender },
      to: [{ email: message.to }],
      subject: message.subject,
      htmlContent: message.html,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${text}`);
  const body = JSON.parse(text) as { messageId?: string };
  if (!body.messageId) throw new Error('Brevo response had no messageId');
  return body.messageId;
}
