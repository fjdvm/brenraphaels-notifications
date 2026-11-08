import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { app } from '../app';
import { parseConfig, type Env } from '../config';
import { createEmailQueue } from './email-queue';
import { createLive } from './live';

const config = parseConfig(process.env);
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid PORT');
const live = createLive();
const queue = createEmailQueue(config);
const env = {
  ...config,
  ...live.bindings,
  EMAIL_QUEUE: queue,
} as unknown as Env;
await queue.recover();
const fetch = (request: Request) => Promise.resolve(app.fetch(request, env));
const server = serve({ fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Notifications listening on ${info.port}`);
}) as Server;
live.attach(server, fetch);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 35_000);
  deadline.unref();
  live.close();
  server.close(() => {
    void queue.close().then(() => clearTimeout(deadline));
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
