import { Body, Controller, Post } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import { SendNotificationDto } from './dto/send-notification.dto.js';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Post()
  async send(@Body() dto: SendNotificationDto): Promise<void> {
    await this.service.enqueue(dto);
  }
}
