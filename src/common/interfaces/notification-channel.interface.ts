export interface NotificationPayload {
  recipient: string;
  subject?: string;
  body: string;
}

export interface NotificationChannel {
  send(payload: NotificationPayload): Promise<void>;
}
