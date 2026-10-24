// All settings come from environment variables; see .env.example.
const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(env.PORT, 3000),
  appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa',
  firmName: env.FIRM_NAME || 'Voixa Accounting',
  trustProxy: env.TRUST_PROXY === '1',
  secureCookies: (env.APP_URL || '').startsWith('https://'),
  sessionDays: num(env.SESSION_DAYS, 30),
  loginLinkMinutes: num(env.LOGIN_LINK_MINUTES, 30),
  maxUploadMb: num(env.MAX_UPLOAD_MB, 25),

  storage: {
    driver: env.STORAGE_DRIVER || 'fs',
    dir: env.STORAGE_DIR || './data/files',
    bucket: env.S3_BUCKET,
    region: env.S3_REGION || 'eu-south-2',
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === '1',
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },

  mail: {
    transport: env.MAIL_TRANSPORT || 'console',
    from: env.MAIL_FROM || 'Voixa Exchange <exchange@voixa.es>',
    smtpUrl: env.SMTP_URL,
    postmarkToken: env.POSTMARK_TOKEN,
    postmarkStream: env.POSTMARK_STREAM || 'outbound',
    webhookToken: env.WEBHOOK_TOKEN || '',
  },

  scheduler: {
    enabled: env.SCHEDULER !== 'off',
    intervalMinutes: num(env.SCHEDULER_INTERVAL_MIN, 10),
    unopenedHours: num(env.REMINDER_UNOPENED_HOURS, 48),
    unconfirmedHours: num(env.REMINDER_UNCONFIRMED_HOURS, 72),
    repeatHours: num(env.REMINDER_REPEAT_HOURS, 48),
    maxAutoReminders: num(env.MAX_AUTO_REMINDERS, 3),
  },
};
