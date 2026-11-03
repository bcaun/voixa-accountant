import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { HttpError, loadUser, redeemToken, requireAppHeader, setSessionCookie } from './auth.js';
import { handlePostmarkWebhook } from './mailer.js';
import { api } from './routes/api.js';
import { authPage, revokePage, oauthPage, PAGE_LANGS } from './pages.js';
import * as oauth from './oauth.js';
import { icsFor } from './calendar.js';
import { createSession } from './auth.js';
import { revokeFromAlert } from './devices.js';
import { handleInbound } from './inbound.js';
import { verifyStripeSignature, handleStripeEvent } from './billing.js';
import { finish as finishBank } from './bankfeeds.js';
import { alert } from './alerts.js';
import { sendDirect } from './mailer.js';
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
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'",
    });
    next();
  });

  app.get('/healthz', async (_req, res) => {
    await pool.query('select 1');
    res.json({ ok: true });
  });
  // Deeper check for monitoring: database, mail queue, background work and virus scanner
  app.get('/healthz/deep', async (req, res) => {
    const got = Buffer.from(String(req.query.token || '')), want = Buffer.from(config.mail.webhookToken);
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Bad token.');
    const [{ rows: [q] }, { rows: [j] }] = await Promise.all([
      pool.query(`select count(*) filter (where status = 'queued' and created_at < now() - interval '15 minutes')::int as stuck, count(*) filter (where status = 'failed' and attempts >= 5)::int as failed from email_messages`),
      pool.query(`select count(*) filter (where status in ('queued','running') and updated_at < now() - interval '30 minutes')::int as stuck from jobs`),
    ]);
    const { scanningOn } = await import('./antivirus.js');
    let scanner = 'off';
    if (scanningOn()) { const { scanStream } = await import('./antivirus.js'); scanner = await scanStream((await import('node:stream')).Readable.from([Buffer.from('ping')])).then(() => 'ok', () => 'down'); }
    const ok = !q.stuck && !j.stuck && scanner !== 'down';
    res.status(ok ? 200 : 503).json({ ok, mail: { stuck: q.stuck, failed: q.failed }, jobs: { stuck: j.stuck }, scanner });
  });

  // Postmark delivery webhooks: delivery, bounce, spam complaint, open
  app.post('/webhooks/postmark', express.json({ limit: '1mb' }), async (req, res) => {
    const got = Buffer.from(String(req.query.token || ''));
    const want = Buffer.from(config.mail.webhookToken);
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Bad token.');
    await handlePostmarkWebhook(req.body || {});
    res.json({ ok: true });
  });

  // Documents by email (Postmark inbound). Always answers 200 so Postmark does not retry refused mail.
  // Stripe subscription events, verified by signature against the raw body
  app.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!verifyStripeSignature(raw, req.get('stripe-signature'))) throw new HttpError(400, 'Bad signature.');
    await handleStripeEvent(JSON.parse(raw));
    res.json({ received: true });
  });

  app.post('/webhooks/postmark-inbound', express.json({ limit: '45mb' }), async (req, res) => {
    const got = Buffer.from(String(req.query.token || ''));
    const want = Buffer.from(config.mail.webhookToken);
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Bad token.');
    res.json(await handleInbound(req.body || {}));
  });

  // Demo requests from the website (a plain HTML form on pescada.io, no JavaScript needed)
  const demoHits = new Map();
  const THANKS = { en: '/thanks/', es: '/es/gracias/', it: '/it/grazie/', fr: '/fr/merci/', de: '/de/danke/', pt: '/pt/obrigado/' };
  app.post('/public/demo', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    const b = req.body || {};
    const lang = THANKS[b.lang] ? b.lang : 'en';
    const back = `${config.siteUrl}${THANKS[lang]}`;
    if (b.website) return res.redirect(303, back); // the hidden field only robots fill in
    const now = Date.now(), hits = (demoHits.get(req.ip) || []).filter((t) => now - t < 3600e3);
    if (hits.length >= 5) return res.redirect(303, back);
    demoHits.set(req.ip, [...hits, now]);
    const f = (k, n = 300) => String(b[k] || '').trim().slice(0, n);
    const r = { name: f('name', 200), firm: f('firm', 200), email: f('email', 200).toLowerCase(), country: f('country', 40), clients: f('clients', 40), message: f('message', 3000) };
    if (!r.name || !r.firm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) return res.redirect(303, `${config.siteUrl}${lang === 'en' ? '/' : `/${lang}/`}#demo`);
    await pool.query('insert into demo_requests (name, firm, email, country, clients, message, lang, ip) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.name, r.firm, r.email, r.country, r.clients, r.message, lang, req.ip]);
    await sendDirect(config.demoEmail, `Demo request: ${r.firm} (${r.country || lang.toUpperCase()})`,
      `Name: ${r.name}\nFirm: ${r.firm}\nEmail: ${r.email}\nCountry: ${r.country}\nClients: ${r.clients}\nLanguage: ${lang}\n\n${r.message}`).catch((err) => console.error('demo mail', err.message));
    res.redirect(303, back);
  });

  // The bank sends the client back here after they authorised access
  app.get('/bank/callback', async (req, res) => {
    const r = await finishBank({ ref: req.query.ref, state: req.query.state, code: req.query.code, error: req.query.error }).catch((err) => { console.error('bank callback', err.message); return null; });
    res.redirect(303, r ? `/#/c/${r.companyId}?bank=${r.ok ? 'ok' : 'failed'}` : '/');
  });

  // Private deadline feeds for Google Calendar, Outlook or Apple Calendar. The address is the key.
  app.get('/calendar/:file', async (req, res) => {
    const ics = await icsFor(String(req.params.file).replace(/\.ics$/, ''));
    if (!ics) return res.status(404).type('text/plain').send('Not found');
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=900', 'Content-Disposition': 'inline; filename="pescada.ics"' });
    res.send(ics);
  });

  // Firms' logos, shown in their clients' emails and spaces. The address is a random key.
  app.get('/logos/:key', async (req, res) => {
    if (!/^[0-9a-f]{32}$/.test(req.params.key)) return res.status(404).end();
    const { rows: [f] } = await pool.query('select logo, logo_type from firms where logo_key = $1', [req.params.key]);
    if (!f?.logo) return res.status(404).end();
    res.set({ 'Content-Type': f.logo_type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    res.send(f.logo);
  });

  // Sign-in links open a page with a button instead of signing in on GET, so
  // mail scanners that pre-fetch links cannot use up the token.
  const pageLang = (req) => req.acceptsLanguages(...PAGE_LANGS) || 'en';
  app.get('/auth/verify', (req, res) => {
    res.send(authPage({ token: String(req.query.token || ''), lang: pageLang(req) }));
  });
  // Sign in with Google or Microsoft, or link such an account to the signed-in person
  app.get('/auth/oauth/:provider/start', loadUser, async (req, res) => {
    try {
      res.redirect(303, await oauth.startUrl(req.params.provider, { mode: req.query.mode === 'link' ? 'link' : 'signin', user: req.user, lang: pageLang(req) }));
    } catch (err) { res.status(err.status || 500).send(oauthPage({ message: err.status ? err.message : 'Something went wrong. Try again.', lang: pageLang(req) })); }
  });
  app.get('/auth/oauth/:provider/callback', loadUser, async (req, res) => {
    if (req.query.error) return res.redirect(303, '/'); // the person cancelled at the provider
    try {
      const r = await oauth.finish(req.params.provider, { code: req.query.code, state: req.query.state, currentUser: req.user });
      if (r.linked) return res.redirect(303, '/#/?linked=' + encodeURIComponent(req.params.provider));
      if (r.unknown) return res.status(403).send(oauthPage({ state: 'unknown', provider: r.label, lang: r.lang || pageLang(req) }));
      setSessionCookie(res, await createSession(r.user, { userAgent: req.get('user-agent'), ip: req.ip }));
      res.redirect(303, '/');
    } catch (err) { res.status(err.status || 500).send(oauthPage({ message: err.status ? err.message : 'Something went wrong. Try again.', lang: pageLang(req) })); }
  });

  // "This was not me" from a new-sign-in warning: a page with a button, then every session ends
  app.get('/auth/revoke', (req, res) => {
    res.send(revokePage({ token: String(req.query.token || ''), lang: pageLang(req) }));
  });
  app.post('/auth/revoke', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const u = await revokeFromAlert(req.body?.token);
    res.status(u ? 200 : 400).send(revokePage({ state: u ? 'done' : 'expired', lang: pageLang(req) }));
  });
  app.post('/auth/verify', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const sid = await redeemToken(req.body?.token, { userAgent: req.get('user-agent'), ip: req.ip });
    if (!sid) return res.status(400).send(authPage({ expired: true, lang: pageLang(req) }));
    setSessionCookie(res, sid);
    res.redirect(303, '/');
  });

  app.use('/api', loadUser, requireAppHeader, api);
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { index: 'index.html', maxAge: '5m' }));
  // the browser half of the passkey library, served as ES modules
  app.use('/vendor/webauthn', express.static(fileURLToPath(new URL('../node_modules/@simplewebauthn/browser/esm/', import.meta.url)), { maxAge: '1d' }));

  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) { console.error(err); alert('Server error', `${req.method} ${req.path}\n\n${err.stack || err.message}`); }
    if (res.headersSent) return res.destroy();
    const message = status >= 500 ? 'Something went wrong on our side. Try again in a minute.' : err.message;
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) return res.status(status).json({ error: message, ...(status < 500 && typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? { code: err.code } : {}) });
    res.status(status).send(message);
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  createApp().listen(config.port, () => console.log(`Pescada on ${config.appUrl} (port ${config.port})`));
  startScheduler();
  process.on('unhandledRejection', (err) => alert('Unhandled error', err?.stack || String(err)));
  alert('Server started', 'The application (re)started. If you did not deploy just now, check why it restarted.').catch(() => {});
}
