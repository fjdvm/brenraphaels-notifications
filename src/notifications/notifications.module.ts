import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { EmailModule } from '../channels/email/email.module.js';
import { WebsocketModule } from '../channels/websocket/websocket.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationsProcessor } from './notifications.processor.js';

@Module({
  imports: [QueueModule, EmailModule, WebsocketModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsProcessor],
})
export class NotificationsModule {}
