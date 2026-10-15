import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';
import { Injectable } from '@nestjs/common';
import type {
  NotificationChannel,
  NotificationPayload,
} from '../../common/interfaces/notification-channel.interface.js';

@Injectable()
@WebSocketGateway({ namespace: 'notifications' })
export class NotificationsGateway implements NotificationChannel {
  @WebSocketServer()
  server!: Server;

  async send(_payload: NotificationPayload): Promise<void> {
    // TODO: emit to recipient room
  }
}
