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
  // accountants see every client of the firm, so their sessions are shorter and end after a quiet spell
  accountantSessionDays: num(env.ACCOUNTANT_SESSION_DAYS, 7),
  accountantIdleHours: num(env.ACCOUNTANT_IDLE_HOURS, 12),
  secretKey: env.SECRET_KEY || '',
  alertEmail: env.ALERT_EMAIL || '',
  // emails go out in each person's language, or their country's ('auto'); a code (en, es…) forces one for people who chose none
  emailLang: env.EMAIL_LANG || 'auto',
  // the website's demo form posts here; requests are emailed to DEMO_EMAIL and the visitor goes back to SITE_URL
  demoEmail: env.DEMO_EMAIL || 'hello@pescada.io',
  supportEmail: env.SUPPORT_EMAIL || env.DEMO_EMAIL || 'hello@pescada.io',
  siteUrl: (env.SITE_URL || 'https://pescada.io').replace(/\/$/, ''),
  loginLinkMinutes: num(env.LOGIN_LINK_MINUTES, 30),
  maxUploadMb: num(env.MAX_UPLOAD_MB, 25),
  // closing a client: days the firm can still export, and years documents are kept after upload
  closeExportDays: num(env.CLOSE_EXPORT_DAYS, 30),
  retentionYears: num(env.RETENTION_YEARS, 6),

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
    from: env.MAIL_FROM || 'Pescada <notifications@pescada.io>',
    smtpUrl: env.SMTP_URL,
    postmarkToken: env.POSTMARK_TOKEN,
    postmarkStream: env.POSTMARK_STREAM || 'outbound',
    webhookToken: env.WEBHOOK_TOKEN || '',
    // documents by email: <key>@INBOUND_DOMAIN, delivered to /webhooks/postmark-inbound (empty = off)
    inboundDomain: (env.INBOUND_DOMAIN || '').toLowerCase(),
    inboundRequireAuth: env.INBOUND_REQUIRE_AUTH !== 'off',
  },

  recognition: {
    // reading PDFs and scans needs ANTHROPIC_API_KEY; Norma 43, camt.053 and CSV are parsed without it
    ai: env.RECOGNITION_AI !== 'off',
    model: env.RECOGNITION_MODEL || 'claude-opus-5-5',
    maxAiFileMb: num(env.RECOGNITION_MAX_AI_MB, 20),
    // stop sending files to the AI reader once this month's estimated spend reaches it (0 = no limit)
    monthlyBudgetUsd: num(env.AI_MONTHLY_BUDGET_USD, 0),
  },

  // self sign-up and billing (Stripe is optional: without a key, sign-up still works and firms stay on trial)
  signup: {
    enabled: env.SIGNUP !== 'off', trialDays: num(env.TRIAL_DAYS, 30),
    dailyMax: num(env.SIGNUP_DAILY_MAX, 20),            // sign-up requests per day, all together
    trialMaxClients: num(env.TRIAL_MAX_CLIENTS, 10),    // open clients a trial firm can have
    trialMaxInvites: num(env.TRIAL_MAX_INVITES, 20),    // invitation emails a trial firm can send per day
    notifyEmail: env.SIGNUP_NOTIFY_EMAIL || env.DEMO_EMAIL || 'hello@pescada.io',
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    priceId: env.STRIPE_PRICE_ID || '',          // Standard plan
    priceIdPro: env.STRIPE_PRICE_ID_PRO || '',   // Pro plan: adds AI reading of PDFs and photos
    // 'clients': one unit per open client workspace; 'firm': one unit per firm
    quantity: env.STRIPE_QUANTITY === 'firm' ? 'firm' : 'clients',
    apiBase: env.STRIPE_API_BASE || 'https://api.stripe.com',
  },

  // trusted timestamps on the evidence log (RFC 3161); off until TSA_URL is set
  tsa: {
    url: env.TSA_URL || '', user: env.TSA_USER || '', password: env.TSA_PASSWORD || '', policy: env.TSA_POLICY || '',
    name: env.TSA_NAME || (() => { try { return new URL(env.TSA_URL).hostname; } catch { return ''; } })(),
    qualified: env.TSA_QUALIFIED === 'yes',            // say "qualified" only for a TSA on the EU trusted list
    intervalMin: num(env.TSA_INTERVAL_MIN, 60),
  },

  // electronic seal on issued PDFs: remotely through a trust service provider (CSC API v2), or from files
  seal: {
    name: env.SEAL_NAME || '',                          // e.g. "Voixa Consultors S.L."
    qualified: env.SEAL_QUALIFIED === 'yes',            // only for a qualified seal certificate (QSealC)
    certFile: env.SEAL_CERT_FILE || '', keyFile: env.SEAL_KEY_FILE || '', chainFile: env.SEAL_CHAIN_FILE || '',
    cscUrl: env.SEAL_CSC_URL || '', cscTokenUrl: env.SEAL_CSC_TOKEN_URL || '', cscClientId: env.SEAL_CSC_CLIENT_ID || '',
    cscClientSecret: env.SEAL_CSC_CLIENT_SECRET || '', cscCredentialId: env.SEAL_CSC_CREDENTIAL_ID || '', cscPin: env.SEAL_CSC_PIN || '',
  },

  // sign in with Google / Microsoft (OpenID Connect); each is off until its client ID and secret are set
  oauth: {
    google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token' },
    microsoft: { clientId: env.MICROSOFT_CLIENT_ID || '', clientSecret: env.MICROSOFT_CLIENT_SECRET || '', tenant: env.MICROSOFT_TENANT || 'organizations',
      authUrl: env.MICROSOFT_AUTH_URL || '', tokenUrl: env.MICROSOFT_TOKEN_URL || '' },
  },

  // bank statements through open banking (GoCardless Bank Account Data); off without keys
  bankFeeds: {
    secretId: env.GOCARDLESS_SECRET_ID || '',
    secretKey: env.GOCARDLESS_SECRET_KEY || '',
    apiBase: env.GOCARDLESS_API_BASE || 'https://bankaccountdata.gocardless.com',
    syncHours: num(env.BANK_FEED_SYNC_HOURS, 12),
  },

  // virus scanning with ClamAV; off when CLAMAV_HOST is not set
  clamav: {
    host: env.CLAMAV_HOST || '',
    port: num(env.CLAMAV_PORT, 3310),
    timeoutMs: num(env.CLAMAV_TIMEOUT_MS, 60000),
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
