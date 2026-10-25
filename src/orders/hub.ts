import { NotificationHub } from '../live/hub';

/** A separate namespace for ephemeral Order events; never shares the bell's sockets. */
export class OrderHub extends NotificationHub {}
