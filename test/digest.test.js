// Accountants get one daily summary instead of an email per event; urgent events still go at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-digest-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost', WEBHOOK_TOKEN: 'hook',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { sentMail, flushEmails, handlePostmarkWebhook } = await import('../src/mailer.js');
const { sendDigests, digestDue } = await import('../src/digest.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

async function as(userId) {
  const token = new URL(await createLoginLink(userId)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, p, body, expect = 200) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
const file = (name) => { const f = new FormData(); f.append('category', 'Other'); f.append('files', new Blob([`%PDF ${name}`], { type: 'application/pdf' }), name); return f; };
const userId = async (email) => (await pool.query('select id from users where email = $1', [email])).rows[0].id;

const ctx = {};

test('notifications for an accountant wait for the daily summary', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Studio Rossi', 'IT') returning id`);
  const { rows: [u] } = await pool.query(`insert into users (email, name, role, firm_id) values ('giulia@studiorossi.it', 'Giulia', 'accountant', $1) returning id`, [f.id]);
  ctx.acc = await as(u.id);
  const me = await ctx.acc('GET', '/me');
  assert.equal(me.user.notifyMode, 'digest');
  const a = await ctx.acc('POST', '/companies', { name: 'Trattoria Uno', contactEmail: 'uno@example.it' }, 201);
  const b = await ctx.acc('POST', '/companies', { name: 'Pizzeria Due', contactEmail: 'due@example.it' }, 201);
  Object.assign(ctx, { a: a.id, b: b.id });
  ctx.uno = await as(await userId('uno@example.it'));
  ctx.due = await as(await userId('due@example.it'));
  await flushEmails();
  sentMail.length = 0;
  await ctx.uno('POST', `/companies/${ctx.a}/documents`, file('fattura-1.pdf'), 201);
  await ctx.due('POST', `/companies/${ctx.b}/documents`, file('fattura-2.pdf'), 201);
  await flushEmails();
  assert.equal(sentMail.filter((m) => m.to_email === 'giulia@studiorossi.it').length, 0);
  const item = (await ctx.acc('GET', `/companies/${ctx.a}`)).items[0];
  assert.equal(item.status.notified_at, null);
});

test('one summary email covers every client, and each item is logged as notified', async () => {
  assert.equal(await sendDigests(new Date(), { force: true }), 1);
  await flushEmails();
  const mail = sentMail.filter((m) => m.to_email === 'giulia@studiorossi.it');
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /2 updates from 2 clients/);
  assert.match(mail[0].body_text, /Trattoria Uno \(#1\)/);
  assert.match(mail[0].body_text, /Pizzeria Due \(#2\)/);
  for (const id of [ctx.a, ctx.b]) {
    const ws = await ctx.acc('GET', `/companies/${id}`);
    assert.ok(ws.items[0].status.notified_at, 'the item counts as notified once the summary is sent');
    assert.ok(ws.events.some((e) => e.type === 'email_sent' && /daily summary/.test(e.text)));
  }
  // delivery and the first open are logged on every item in the summary; a second open is not
  await handlePostmarkWebhook({ RecordType: 'Delivery', Metadata: { email_id: mail[0].id }, MessageID: 'x' });
  await handlePostmarkWebhook({ RecordType: 'Open', Metadata: { email_id: mail[0].id } });
  await handlePostmarkWebhook({ RecordType: 'Open', Metadata: { email_id: mail[0].id } });
  for (const id of [ctx.a, ctx.b]) {
    const evs = (await pool.query('select type from events where company_id = $1', [id])).rows.map((r) => r.type);
    assert.equal(evs.filter((t) => t === 'email_delivered').length, 1);
    assert.equal(evs.filter((t) => t === 'email_opened').length, 1);
  }
  assert.equal(await sendDigests(new Date(), { force: true }), 0, 'nothing left to send');
});

test('urgent events still go at once, and the accountant can switch to one email per event', async () => {
  sentMail.length = 0;
  const req = await ctx.acc('POST', `/companies/${ctx.a}/requests`, { title: 'Estratto conto', due: '2026-12-05' }, 201);
  const ws = await ctx.acc('GET', `/companies/${ctx.a}`);
  const doc = ws.items.find((i) => i.kind === 'doc');
  // a reminder from the client is urgent: it reaches the accountant at once, digest or not
  await ctx.uno('POST', `/items/${doc.id}/remind`, {});
  await ctx.uno('POST', `/items/${doc.id}/comments`, { message: 'Prima nota' }); // not urgent: waits
  await flushEmails();
  assert.equal(sentMail.filter((m) => m.to_email === 'giulia@studiorossi.it').length, 1);
  await ctx.acc('PATCH', '/me', { notifyMode: 'instant' });
  await ctx.uno('POST', `/items/${doc.id}/comments`, { message: 'Seconda pagina allegata' });
  await flushEmails();
  assert.equal(sentMail.filter((m) => m.to_email === 'giulia@studiorossi.it').length, 2);
  await ctx.acc('PATCH', '/me', { notifyMode: 'weekly' }, 400);
  await ctx.acc('PATCH', '/me', { digestHour: 7, notifyMode: 'digest' });
  assert.equal((await ctx.acc('GET', '/me')).user.digestHour, 7);
  assert.ok(req);
});

test('the summary goes out at the chosen hour in the firm’s time zone, once a day', () => {
  const u = { country: 'IT', digest_hour: 8, last_digest_at: null };
  assert.equal(digestDue(u, new Date('2026-11-02T06:30:00Z')), false); // 07:30 in Rome
  assert.equal(digestDue(u, new Date('2026-11-02T07:05:00Z')), true); // 08:05 in Rome
  assert.equal(digestDue({ ...u, last_digest_at: '2026-11-02T07:05:00Z' }, new Date('2026-11-02T15:00:00Z')), false);
  assert.equal(digestDue({ ...u, last_digest_at: '2026-11-02T07:05:00Z' }, new Date('2026-11-03T07:01:00Z')), true);
  // something that has waited more than a day goes out whatever the hour
  assert.equal(digestDue({ ...u, last_digest_at: '2026-11-02T07:05:00Z' }, new Date('2026-11-03T03:00:00Z'), '2026-11-02T00:00:00Z'), true);
});
