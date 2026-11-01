// Documents by email, ZIP download, confirming several at once, and search.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-ux-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  WEBHOOK_TOKEN: 'hook', INBOUND_DOMAIN: 'in.pescada.test',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { sentMail, flushEmails } = await import('../src/mailer.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

async function as(email) {
  const { rows: [u] } = await pool.query('select id from users where email = $1', [email]);
  const token = new URL(await createLoginLink(u.id)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, p, body, expect = 200, raw = false) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body instanceof FormData) opt.body = body; else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    if (raw) { assert.equal(res.status, expect); return Buffer.from(await res.arrayBuffer()); }
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
const inbound = (payload) => fetch(`${base}/webhooks/postmark-inbound?token=hook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
const mail = (to, from, extra = {}) => ({
  From: from, FromFull: { Email: from }, OriginalRecipient: to, ToFull: [{ Email: to }], Subject: 'Factura octubre',
  Headers: [{ Name: 'Received-SPF', Value: 'Pass (sender SPF authorized)' }],
  Attachments: [{ Name: 'F-2026-0101.pdf', ContentType: 'application/pdf', Content: Buffer.from('%PDF factura 0101').toString('base64'), ContentLength: 18 }],
  ...extra,
});
const ctx = {};

test('each workspace has a private address; attachments sent there by its people become documents', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id, notify_mode) values ('elena@voixa.es', 'Elena', 'accountant', $1, 'instant')`, [f.id]);
  ctx.acc = await as('elena@voixa.es');
  ctx.co = (await ctx.acc('POST', '/companies', { name: 'Sol y Mar SL', contactEmail: 'daniel@solymar.es' }, 201)).id;
  ctx.cl = await as('daniel@solymar.es');
  const ws = await ctx.cl('GET', `/companies/${ctx.co}`);
  ctx.addr = ws.company.inbound_address;
  assert.match(ctx.addr, /^[0-9a-f]{14}@in\.pescada\.test$/);
  await flushEmails(); sentMail.length = 0;
  const r = await inbound(mail(ctx.addr, 'Daniel@SolYMar.es'));
  assert.deepEqual([r.status, r.count], ['accepted', 1]);
  await flushEmails();
  const after = await ctx.acc('GET', `/companies/${ctx.co}`);
  const doc = after.items.find((i) => i.versions[0]?.file_name === 'F-2026-0101.pdf');
  assert.equal(doc.category, 'Invoice');
  assert.ok(after.events.some((e) => e.item_id === doc.id && /Sent by email from daniel@solymar\.es/.test(e.text)));
  assert.ok(sentMail.some((m) => m.to_email === 'daniel@solymar.es' && /F-2026-0101\.pdf/.test(m.body_text)), 'the sender gets a receipt');
  assert.ok(sentMail.some((m) => m.to_email === 'elena@voixa.es'), 'the accountant is notified as for an upload');
});

test('mail from outsiders, forged senders or unknown addresses is refused', async () => {
  assert.equal((await inbound(mail(ctx.addr, 'stranger@example.com'))).status, 'refused');
  const forged = await inbound(mail(ctx.addr, 'daniel@solymar.es', { Headers: [{ Name: 'Received-SPF', Value: 'Fail' }] }));
  assert.match(forged.reason, /SPF or DKIM/);
  assert.equal((await inbound(mail('00000000000000@in.pescada.test', 'daniel@solymar.es'))).status, 'unknown_address');
  const bad = await fetch(`${base}/webhooks/postmark-inbound?token=nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 401);
  const log = await ctx.acc('GET', `/companies/${ctx.co}/events?limit=50`);
  assert.equal(log.events.filter((e) => e.type === 'email_in_refused').length, 2);
});

test('several documents download as one ZIP, each logged as downloaded, and can then be confirmed together', async () => {
  const f = new FormData(); f.append('category', 'Other');
  f.append('files', new Blob(['%PDF uno']), 'uno.pdf'); f.append('files', new Blob(['%PDF dos']), 'dos.pdf');
  await ctx.cl('POST', `/companies/${ctx.co}/documents`, f, 201);
  const ws = await ctx.acc('GET', `/companies/${ctx.co}`);
  const docs = ws.items.filter((i) => i.kind === 'doc');
  const before = await ctx.acc('POST', `/companies/${ctx.co}/confirm-many`, { ids: docs.map((d) => d.id) });
  assert.equal(before.confirmed.length, 0, 'nothing can be confirmed before it is opened');
  const zip = await ctx.acc('GET', `/companies/${ctx.co}/archive?ids=${docs.map((d) => d.id).join(',')}`, undefined, 200, true);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const names = [];
  for (let i = 0; i < zip.length - 4; i++) if (zip.readUInt32LE(i) === 0x02014b50) names.push(zip.subarray(i + 46, i + 46 + zip.readUInt16LE(i + 28)).toString());
  assert.equal(names.length, docs.length + 1);
  assert.ok(names.includes('manifest.csv'));
  assert.ok(names.some((n) => /^PX-001-\d{4} uno\.pdf$/.test(n)));
  // the first entry really holds the file's bytes
  const nlen = zip.readUInt16LE(26), csize = zip.readUInt32LE(18), method = zip.readUInt16LE(8);
  const body = zip.subarray(30 + nlen, 30 + nlen + csize);
  assert.match((method === 8 ? inflateRawSync(body) : body).toString(), /^%PDF/);
  const after = await ctx.acc('POST', `/companies/${ctx.co}/confirm-many`, { ids: docs.map((d) => d.id) });
  assert.equal(after.confirmed.length, docs.length);
  const ws2 = await ctx.acc('GET', `/companies/${ctx.co}`);
  assert.ok(ws2.items.filter((i) => i.kind === 'doc').every((i) => i.status.state === 'done'));
  assert.ok(ws2.events.filter((e) => e.type === 'downloaded').length >= docs.length);
});

test('search finds documents by title, file name, reference and client, only where the person has access', async () => {
  const r1 = await ctx.acc('GET', '/search?q=0101');
  assert.ok(r1.results.some((x) => x.file_name === 'F-2026-0101.pdf'));
  const r2 = await ctx.acc('GET', '/search?q=PX-001-0001');
  assert.equal(r2.results[0]?.ref, 'PX-001-0001');
  const r3 = await ctx.cl('GET', '/search?q=sol y mar');
  assert.ok(r3.results.length >= 1);
  const { rows: [f2] } = await pool.query(`insert into firms (name, country) values ('Other', 'IT') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id) values ('x@other.it', 'X', 'accountant', $1)`, [f2.id]);
  const other = await as('x@other.it');
  assert.equal((await other('GET', '/search?q=0101')).results.length, 0);
});
