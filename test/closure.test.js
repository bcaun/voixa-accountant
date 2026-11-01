// Closing a client: access ends, the firm exports, then the workspace is blocked and finally purged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-close-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { sentMail, flushEmails } = await import('../src/mailer.js');
const { runClosures } = await import('../src/closure.js');

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
const filesOnDisk = async () => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((d) => d.isFile()).length;
const ctx = {};

test('only an administrator closes a client, after typing its name; the client loses access at once', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id) values ('elena@voixa.es', 'Elena', 'accountant', $1)`, [f.id]);
  await pool.query(`insert into users (email, name, role, firm_id, firm_role) values ('pablo@voixa.es', 'Pablo', 'accountant', $1, 'staff')`, [f.id]);
  ctx.acc = await as('elena@voixa.es');
  ctx.staff = await as('pablo@voixa.es');
  ctx.co = (await ctx.acc('POST', '/companies', { name: 'Sol y Mar SL', contactEmail: 'daniel@solymar.es' }, 201)).id;
  ctx.cl = await as('daniel@solymar.es');
  const f2 = new FormData(); f2.append('category', 'Other'); f2.append('files', new Blob(['%PDF factura']), 'factura.pdf');
  await ctx.cl('POST', `/companies/${ctx.co}/documents`, f2, 201);
  assert.ok(await filesOnDisk() >= 1);
  await ctx.staff('POST', `/companies/${ctx.co}/close`, { confirm: 'Sol y Mar SL' }, 403);
  await ctx.acc('POST', `/companies/${ctx.co}/close`, { confirm: 'Sol y Mar' }, 400);
  await flushEmails(); sentMail.length = 0;
  await ctx.acc('POST', `/companies/${ctx.co}/close`, { confirm: 'Sol y Mar SL', reason: 'contract ended' });
  await flushEmails();
  assert.ok(sentMail.some((m) => m.to_email === 'daniel@solymar.es' && /closed/.test(m.subject)), 'the client is told');
  assert.deepEqual((await ctx.cl('GET', '/me')).companies, []);
  await ctx.cl('GET', `/companies/${ctx.co}`, undefined, 404);
});

test('a closed client is read-only for the firm, which can export everything or reopen it', async () => {
  const ws = await ctx.acc('GET', `/companies/${ctx.co}`);
  assert.ok(ws.company.closed_at && ws.company.export_until && ws.company.purge_after);
  assert.equal(ws.company.inbound_address, null);
  await ctx.acc('POST', `/companies/${ctx.co}/requests`, { title: 'x', due: '2026-12-01' }, 409);
  await ctx.acc('POST', `/items/${ws.items[0].id}/comments`, { message: 'x' }, 409);
  const zip = await ctx.acc('GET', `/companies/${ctx.co}/export-all`, undefined, 200, true);
  const text = zip.toString('latin1');
  for (const n of ['activity-log.csv', 'tracking-report.html', 'files.csv', 'factura.pdf']) assert.ok(text.includes(n), n);
  await ctx.acc('POST', `/companies/${ctx.co}/reopen`);
  assert.equal((await ctx.cl('GET', '/me')).companies.length, 1, 'reopened: the client is back');
  await ctx.acc('POST', `/companies/${ctx.co}/close`, { confirm: 'Sol y Mar SL' });
});

test('after the export period the workspace is blocked, visible to no one', async () => {
  const r = await runClosures(new Date(Date.now() + 31 * 864e5));
  assert.equal(r.blocked, 1);
  assert.equal(r.purged, 0, 'files are kept for the retention period');
  await ctx.acc('GET', `/companies/${ctx.co}`, undefined, 404);
  assert.deepEqual((await ctx.acc('GET', '/me')).companies, []);
  await ctx.acc('POST', `/companies/${ctx.co}/reopen`, undefined, 404);
  // the log itself still refuses ordinary deletes
  await assert.rejects(pool.query('delete from events where company_id = $1', [ctx.co]), /append-only/);
});

test('when the retention period is over, everything is deleted, log and files included', async () => {
  const r = await runClosures(new Date(Date.now() + 7 * 365 * 864e5));
  assert.equal(r.purged, 1);
  for (const t of ['companies', 'events', 'items']) {
    const { rows } = await pool.query(`select count(*)::int as n from ${t} ${t === 'companies' ? 'where id = $1' : 'where company_id = $1'}`, [ctx.co]);
    assert.equal(rows[0].n, 0, t);
  }
  assert.equal(await filesOnDisk(), 0);
  const { rows: u } = await pool.query(`select 1 from users where email = 'daniel@solymar.es'`);
  assert.equal(u.length, 0, 'the client’s person, in no other workspace, is deleted');
  const log = (await ctx.acc('GET', '/firm/events')).events.map((e) => e.type);
  assert.ok(log.includes('client_purged') && log.includes('client_closed') && log.includes('client_blocked'));
});
