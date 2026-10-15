import { Injectable } from '@nestjs/common';
import type {
  NotificationChannel,
  NotificationPayload,
} from '../../common/interfaces/notification-channel.interface.js';

@Injectable()
export class EmailService implements NotificationChannel {
  async send(_payload: NotificationPayload): Promise<void> {
    // TODO: nodemailer transport
  }
}
