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
