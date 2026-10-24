import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { HttpError, loadUser, redeemToken, requireAppHeader, setSessionCookie } from './auth.js';
import { handlePostmarkWebhook } from './mailer.js';
import { api } from './routes/api.js';
import { authPage } from './pages.js';
import { startScheduler } from './scheduler.js';
import { timingSafeEqual } from 'node:crypto';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'",
    });
    next();
  });

  app.get('/healthz', async (_req, res) => {
    await pool.query('select 1');
    res.json({ ok: true });
  });

  // Postmark delivery webhooks: delivery, bounce, spam complaint, open
  app.post('/webhooks/postmark', express.json({ limit: '1mb' }), async (req, res) => {
    const got = Buffer.from(String(req.query.token || ''));
    const want = Buffer.from(config.mail.webhookToken);
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Bad token.');
    await handlePostmarkWebhook(req.body || {});
    res.json({ ok: true });
  });

  // Sign-in links open a page with a button instead of signing in on GET, so
  // mail scanners that pre-fetch links cannot use up the token.
  app.get('/auth/verify', (req, res) => {
    res.send(authPage({ token: String(req.query.token || '') }));
  });
  app.post('/auth/verify', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const sid = await redeemToken(req.body?.token, { userAgent: req.get('user-agent'), ip: req.ip });
    if (!sid) return res.status(400).send(authPage({ expired: true }));
    setSessionCookie(res, sid);
    res.redirect(303, '/');
  });

  app.use('/api', loadUser, requireAppHeader, api);
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { index: 'index.html', maxAge: '5m' }));

  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.destroy();
    const message = status >= 500 ? 'Something went wrong on our side. Try again in a minute.' : err.message;
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) return res.status(status).json({ error: message });
    res.status(status).send(message);
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  createApp().listen(config.port, () => console.log(`Voixa Exchange on ${config.appUrl} (port ${config.port})`));
  startScheduler();
}
