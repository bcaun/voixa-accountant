// Operator alerts and the deep health check.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', SCHEDULER: 'off', ALERT_EMAIL: 'ops@pescada.io', WEBHOOK_TOKEN: 'hook',
});
const { alert } = await import('../src/alerts.js');
const { sentMail } = await import('../src/mailer.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { pool } = await import('../src/db.js');
after(() => pool.end());

test('alerts are emailed once per kind per 15 minutes, counting the ones held back', async () => {
  assert.equal(await alert('Server error', 'boom 1'), true);
  assert.equal(await alert('Server error', 'boom 2'), false);
  assert.equal(await alert('Background work failed', 'other'), true);
  const mails = sentMail.filter((m) => m.to_email === 'ops@pescada.io');
  assert.equal(mails.length, 2);
  assert.match(mails[0].subject, /^\[Pescada\] Server error/);
});

test('the deep health check needs the token and reports mail, jobs and scanner', async () => {
  await migrate();
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/healthz/deep`)).status, 401);
  const r = await fetch(`${base}/healthz/deep?token=hook`);
  const body = await r.json();
  assert.equal(body.scanner, 'off');
  assert.ok('mail' in body && 'jobs' in body);
  server.close();
});

test('the website demo form is stored, emailed, and sends the visitor to the thank-you page', async () => {
  await migrate();
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (fields) => fetch(`${base}/public/demo`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  sentMail.length = 0;
  const r = await send({ name: 'Giulia Rossi', firm: 'Studio Rossi', email: 'giulia@studiorossi.it', country: 'Italy', clients: '50-150', message: 'Ciao', lang: 'it' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://pescada.io/it/grazie/');
  assert.equal(sentMail.length, 1);
  assert.match(sentMail[0].subject, /Demo request: Studio Rossi \(Italy\)/);
  const { rows } = await pool.query(`select firm, lang from demo_requests where email = 'giulia@studiorossi.it'`);
  assert.deepEqual(rows[0], { firm: 'Studio Rossi', lang: 'it' });
  // a robot filling the hidden field gets the same page and nothing is stored
  await send({ name: 'x', firm: 'y', email: 'bot@x.io', website: 'http://spam', lang: 'en' });
  assert.equal((await pool.query(`select count(*)::int as n from demo_requests where email = 'bot@x.io'`)).rows[0].n, 0);
  // missing fields send the visitor back to the form
  assert.match((await send({ name: '', firm: 'y', email: 'a@b.c', lang: 'es' })).headers.get('location'), /\/es\/#demo$/);
  server.close();
});
