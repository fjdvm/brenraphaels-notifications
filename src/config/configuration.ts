export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  smtp: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM ?? 'no-reply@example.com',
  },
});
