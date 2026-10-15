import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { NOTIFICATIONS_QUEUE } from '../queue/queue.constants.js';
import type { SendNotificationDto } from './dto/send-notification.dto.js';

@Injectable()
export class NotificationsService {
  constructor(@InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue) {}

  async enqueue(dto: SendNotificationDto): Promise<void> {
    await this.queue.add('send', dto);
  }
}
