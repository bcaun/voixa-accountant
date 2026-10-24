// End-to-end tests against a real PostgreSQL database.
// TEST_DATABASE_URL must point at a database the tests may wipe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'voixa-test-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off',
  APP_URL: 'http://localhost', WEBHOOK_TOKEN: 'hook-secret', FIRM_NAME: 'Voixa Accounting',
});

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { sentMail, flushEmails } = await import('../src/mailer.js');
const { runScheduler } = await import('../src/scheduler.js');

let server, base;
const sha = (b) => createHash('sha256').update(b).digest('hex');

before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await pool.end();
  await rm(dir, { recursive: true, force: true });
});

async function signIn(link) {
  const token = new URL(link).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  assert.equal(r.status, 303);
  return r.headers.get('set-cookie').split(';')[0];
}
function client(cookie) {
  const call = async (method, p, body, expect = 200) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(`${base}/api${p}`, opt);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, expect, `${method} ${p} → ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };
  return { get: (p, e) => call('GET', p, undefined, e), post: (p, b, e = 200) => call('POST', p, b, e), del: (p, e) => call('DELETE', p, undefined, e) };
}
const fileForm = (fields, files) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const [name, content] of files) f.append('files', new Blob([content], { type: 'application/pdf' }), name);
  return f;
};
const linkIn = (mail) => /https?:\/\/\S+token=\S+/.exec(mail.body_text)[0];

const ctx = {};

test('accountant signs in and creates a client workspace with an invite', async () => {
  const { rows: [acc] } = await pool.query(`insert into users (email, name, role) values ('elena@voixa.es', 'Elena Ruiz', 'accountant') returning *`);
  ctx.acc = client(await signIn(await createLoginLink(acc.id)));
  const me = await ctx.acc.get('/me');
  assert.equal(me.user.role, 'accountant');

  const co = await ctx.acc.post('/companies', { name: 'Sol y Mar Hospitality SL', nif: 'B56781234', city: 'Valencia', contactName: 'Daniel Moreau', contactEmail: 'daniel@solymar.es' }, 201);
  ctx.co1 = co.id;
  await flushEmails();
  const invite = sentMail.find((m) => m.to_email === 'daniel@solymar.es' && m.kind === 'invite');
  assert.ok(invite, 'invite email sent');
  ctx.daniel = client(await signIn(linkIn(invite)));
  const dme = await ctx.daniel.get('/me');
  assert.deepEqual(dme.companies.map((c) => c.name), ['Sol y Mar Hospitality SL']);
  // the sign-in link is not kept in the database after sending
  const { rows: [stored] } = await pool.query(`select body_text from email_messages where id = $1`, [invite.id]);
  assert.match(stored.body_text, /removed/);
});

test('a used sign-in link cannot be used again, and GET does not sign in', async () => {
  const { rows: [u] } = await pool.query(`select id from users where email = 'daniel@solymar.es'`);
  const link = await createLoginLink(u.id);
  const page = await fetch(link.replace('http://localhost', base));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('set-cookie'), null);
  await signIn(link);
  const token = new URL(link).searchParams.get('token');
  const again = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  assert.equal(again.status, 400);
});

test('client sends a document; accountant must open it before confirming', async () => {
  const content = Buffer.from('%PDF-1.4 invoice F-2026-08812');
  await ctx.daniel.post(`/companies/${ctx.co1}/documents`, fileForm({ category: 'Invoice', period: '2026-10', note: 'Paid by card' }, [['Makro_F-2026-08812.pdf', content]]), 201);
  let ws = await ctx.acc.get(`/companies/${ctx.co1}`);
  const doc = ws.items.find((i) => i.kind === 'doc');
  ctx.doc = doc.id;
  assert.equal(doc.status.state, 'sent');
  assert.equal(doc.versions[0].sha256, sha(content), 'server-side fingerprint matches the bytes');
  assert.equal(doc.ref, 'VX-001-0001');

  await flushEmails();
  assert.ok(sentMail.some((m) => m.to_email === 'elena@voixa.es' && m.kind === 'new_document'), 'accountant notified');
  ws = await ctx.acc.get(`/companies/${ctx.co1}`);
  assert.ok(ws.items.find((i) => i.id === ctx.doc).status.notified_at, 'notification step recorded');

  await ctx.acc.post(`/items/${ctx.doc}/confirm`, {}, 409);
  const body = await ctx.acc.get(`/items/${ctx.doc}/file`);
  assert.equal(Buffer.compare(body, content), 0);
  await ctx.acc.post(`/items/${ctx.doc}/confirm`, {});
  ws = await ctx.daniel.get(`/companies/${ctx.co1}`);
  const after = ws.items.find((i) => i.id === ctx.doc);
  assert.equal(after.status.state, 'done');
  assert.ok(ws.events.some((e) => e.type === 'opened' && e.actor_type === 'accountant'));
  await flushEmails();
  assert.ok(sentMail.some((m) => m.to_email === 'daniel@solymar.es' && m.kind === 'confirmed'), 'client gets the confirmation by email');
});

test('replacing a file keeps the old version and resets confirmation', async () => {
  const v2 = Buffer.from('%PDF-1.4 invoice F-2026-08812 with page 2');
  const f = new FormData();
  f.append('reason', 'Page 2 was missing');
  f.append('file', new Blob([v2]), 'Makro_F-2026-08812_full.pdf');
  await ctx.acc.post(`/items/${ctx.doc}/versions`, f, 403); // only the sender side may replace
  await ctx.daniel.post(`/items/${ctx.doc}/versions`, f, 201);
  const ws = await ctx.acc.get(`/companies/${ctx.co1}`);
  const it = ws.items.find((i) => i.id === ctx.doc);
  assert.equal(it.status.state, 'sent');
  assert.equal(it.status.version, 2);
  assert.equal(it.versions.length, 2);
  assert.equal(it.versions[1].replace_reason, 'Page 2 was missing');
  assert.equal(it.opened_by_me, false);
  const old = await ctx.acc.get(`/items/${ctx.doc}/file?v=1`);
  assert.match(old.toString(), /F-2026-08812$/);
});

test('clients never see another client’s workspace', async () => {
  const co2 = await ctx.acc.post('/companies', { name: 'Nordlicht Studio SL', contactEmail: 'anna@nordlicht.studio', contactName: 'Anna Berg' }, 201);
  ctx.co2 = co2.id;
  await flushEmails();
  ctx.anna = client(await signIn(linkIn(sentMail.findLast((m) => m.to_email === 'anna@nordlicht.studio'))));
  await ctx.anna.get(`/companies/${ctx.co1}`, 404);
  await ctx.anna.get(`/items/${ctx.doc}/file`, 404);
  await ctx.anna.post(`/items/${ctx.doc}/comments`, { message: 'hi' }, 404);
  await ctx.anna.get(`/companies/${ctx.co1}/export.csv`, 404);
  const me = await ctx.anna.get('/me');
  assert.deepEqual(me.companies.map((c) => c.name), ['Nordlicht Studio SL']);
  await ctx.anna.get('/overview', 403);
});

test('a colleague can be invited into the same company and removed', async () => {
  await ctx.daniel.post(`/companies/${ctx.co1}/members`, { email: 'marta@solymar.es', name: 'Marta Gil' }, 201);
  await ctx.daniel.post(`/companies/${ctx.co1}/members`, { email: 'elena@voixa.es' }, 400);
  let ws = await ctx.acc.get(`/companies/${ctx.co1}`);
  assert.deepEqual(ws.members.map((m) => m.email).sort(), ['daniel@solymar.es', 'marta@solymar.es']);
  await flushEmails();
  const marta = client(await signIn(linkIn(sentMail.findLast((m) => m.to_email === 'marta@solymar.es'))));
  const mws = await marta.get(`/companies/${ctx.co1}`);
  assert.ok(mws.items.some((i) => i.id === ctx.doc), 'colleague sees the shared history');
  const id = ws.members.find((m) => m.email === 'marta@solymar.es').id;
  await ctx.daniel.del(`/companies/${ctx.co1}/members/${id}`);
  await marta.get(`/companies/${ctx.co1}`, 404);
});

test('a request is fulfilled by an upload that answers it', async () => {
  await ctx.acc.post(`/companies/${ctx.co1}/requests`, { title: 'Bank statement, October 2026', due: '2026-11-05', note: 'All pages' }, 201);
  let ws = await ctx.daniel.get(`/companies/${ctx.co1}`);
  const req = ws.items.find((i) => i.kind === 'request');
  await ctx.daniel.post(`/items/${req.id}/seen`, {});
  await ctx.daniel.post(`/companies/${ctx.co1}/documents`, fileForm({ category: 'Bank statement', requestId: req.id }, [['BBVA_2026-10.pdf', 'statement']]), 201);
  ws = await ctx.acc.get(`/companies/${ctx.co1}`);
  const r = ws.items.find((i) => i.id === req.id);
  assert.equal(r.status.state, 'done');
  assert.ok(r.fulfilled_by);
});

test('reports carry a deadline and show whether they were sent on time', async () => {
  const f = new FormData();
  f.append('title', 'Management accounts, October 2026'); f.append('category', 'Financial statements'); f.append('due', '2020-01-20');
  f.append('file', new Blob(['pnl']), 'PyG_2026-10.pdf');
  await ctx.acc.post(`/companies/${ctx.co1}/reports`, f, 201);
  const ws = await ctx.daniel.get(`/companies/${ctx.co1}`);
  const rep = ws.items.find((i) => i.kind === 'report');
  assert.match(ws.events.find((e) => e.item_id === rep.id && e.type === 'uploaded').text, /sent late/);
  await ctx.daniel.post(`/items/${rep.id}/confirm`, {}, 409);
  await ctx.daniel.get(`/items/${rep.id}/file?download=1`);
  await ctx.daniel.post(`/items/${rep.id}/confirm`, {});
});

test('recurring deadlines create requests and expected reports, once', async () => {
  await ctx.acc.post(`/companies/${ctx.co2}/obligations`, { kind: 'request', title: 'Bank statements', category: 'Bank statement', frequency: 'monthly', dueDay: 28, leadDays: 31 }, 201);
  await ctx.acc.post(`/companies/${ctx.co2}/obligations`, { kind: 'report', title: 'Management accounts', category: 'Financial statements', frequency: 'monthly', dueDay: 28, leadDays: 40 }, 201);
  await ctx.daniel.post(`/companies/${ctx.co1}/obligations`, { kind: 'request', title: 'x', frequency: 'monthly', dueDay: 5 }, 403);
  await runScheduler();
  await runScheduler();
  const ws = await ctx.anna.get(`/companies/${ctx.co2}`);
  const generated = ws.items.filter((i) => i.obligation_id);
  assert.equal(generated.filter((i) => i.kind === 'request').length, 1);
  assert.match(generated.find((i) => i.kind === 'request').title, /^Bank statements, \w+ \d{4}$/);
  const expected = generated.find((i) => i.kind === 'report');
  assert.equal(expected.status.state, 'expected');
  // accountant attaches the file to the expected report
  const f = new FormData(); f.append('itemId', expected.id); f.append('file', new Blob(['303']), 'Modelo303.pdf');
  await ctx.acc.post(`/companies/${ctx.co2}/reports`, f, 201);
  const after = (await ctx.anna.get(`/companies/${ctx.co2}`)).items.find((i) => i.id === expected.id);
  assert.equal(after.status.state, 'sent');
});

test('automatic reminders go out for unopened items and are logged', async () => {
  const before = sentMail.length;
  const r = await runScheduler(new Date(Date.now() + 3 * 864e5));
  assert.ok(r.reminded >= 1);
  const ws = await ctx.acc.get(`/companies/${ctx.co1}`);
  assert.ok(ws.events.some((e) => e.type === 'auto_reminder'));
  assert.ok(sentMail.length > before);
  const again = await runScheduler(new Date(Date.now() + 36e5));
  assert.equal(again.reminded, 0, 'no repeat inside the quiet period');
});

test('email delivery webhooks are recorded in the log', async () => {
  const { rows: [m] } = await pool.query(`select id from email_messages where company_id = $1 and status = 'sent' order by created_at limit 1`, [ctx.co1]);
  const bad = await fetch(`${base}/webhooks/postmark?token=nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 401);
  const r = await fetch(`${base}/webhooks/postmark?token=hook-secret`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ RecordType: 'Bounce', Type: 'HardBounce', Description: 'Mailbox does not exist', MessageID: 'pm-1', Metadata: { email_id: m.id } }) });
  assert.equal(r.status, 200);
  const ws = await ctx.acc.get(`/companies/${ctx.co1}`);
  assert.ok(ws.events.some((e) => e.type === 'email_bounced' && /Mailbox does not exist/.test(e.text)));
});

test('the log verifies, exports, and cannot be edited', async () => {
  const v = await ctx.daniel.get(`/companies/${ctx.co1}/verify`);
  assert.equal(v.ok, true);
  assert.ok(v.count > 10);
  const csv = (await ctx.daniel.get(`/companies/${ctx.co1}/export.csv`)).toString();
  assert.match(csv, /seq,time_utc,time_madrid/);
  assert.match(csv, /Makro_F-2026-08812\.pdf/);
  const report = (await ctx.acc.get(`/companies/${ctx.co1}/report?item=${ctx.doc}`)).toString();
  assert.match(report, /Log verified/);
  await assert.rejects(pool.query(`update events set text = 'x' where company_id = $1`, [ctx.co1]), /append-only/);
  await assert.rejects(pool.query(`delete from events where company_id = $1`, [ctx.co1]), /append-only/);
});

test('a tampered log fails verification', async () => {
  // simulate someone with database superuser rights bypassing the trigger
  await pool.query('alter table events disable trigger events_no_update');
  await pool.query(`update events set at = at - interval '3 days' where company_id = $1 and type = 'confirmed'`, [ctx.co1]);
  await pool.query('alter table events enable trigger events_no_update');
  const v = await ctx.acc.get(`/companies/${ctx.co1}/verify`);
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not match/);
});

test('write requests without the app header are refused', async () => {
  const r = await fetch(`${base}/api/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok(r.status === 401 || r.status === 403);
});
