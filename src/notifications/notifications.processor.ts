import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NOTIFICATIONS_QUEUE } from '../queue/queue.constants.js';
import { EmailService } from '../channels/email/email.service.js';
import { NotificationsGateway } from '../channels/websocket/notifications.gateway.js';
import type { SendNotificationDto } from './dto/send-notification.dto.js';

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  constructor(
    private readonly email: EmailService,
    private readonly gateway: NotificationsGateway,
  ) {
    super();
  }

  async process(job: Job<SendNotificationDto>): Promise<void> {
    const { channel, ...payload } = job.data;
    const target = channel === 'email' ? this.email : this.gateway;
    await target.send(payload);
  }
}
