// Virus scanning: a stand-in clamd that flags the EICAR test string.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
let clamd;
const startClamd = (port = 0) => new Promise((resolve) => {
  clamd = net.createServer({ allowHalfOpen: true }, (sock) => {
    const chunks = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      const all = Buffer.concat(chunks).toString('latin1');
      sock.end(all.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
    });
  }).listen(port, '127.0.0.1', () => resolve(clamd.address().port));
});
const port = await startClamd();

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-av-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(port), CLAMAV_TIMEOUT_MS: '3000',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { sentMail, flushEmails } = await import('../src/mailer.js');
const { rescanPending } = await import('../src/scheduler.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); clamd.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

async function as(email) {
  const { rows: [u] } = await pool.query('select id from users where email = $1', [email]);
  const token = new URL(await createLoginLink(u.id)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, p, body, expect = 200) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body instanceof FormData) opt.body = body; else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };
}
const upload = (...files) => { const f = new FormData(); f.append('category', 'Other'); for (const [n, c] of files) f.append('files', new Blob([c]), n); return f; };
const ctx = {};

test('clean files are accepted and marked as scanned', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id, notify_mode) values ('elena@voixa.es', 'Elena', 'accountant', $1, 'instant')`, [f.id]);
  ctx.acc = await as('elena@voixa.es');
  ctx.co = (await ctx.acc('POST', '/companies', { name: 'Sol y Mar SL', contactEmail: 'daniel@solymar.es' }, 201)).id;
  ctx.cl = await as('daniel@solymar.es');
  await ctx.cl('POST', `/companies/${ctx.co}/documents`, upload(['factura.pdf', '%PDF clean invoice']), 201);
  const ws = await ctx.acc('GET', `/companies/${ctx.co}`);
  assert.equal(ws.items[0].versions[0].scan_status, 'clean');
});

test('an infected file is refused, nothing from the upload is kept, and the attempt is logged', async () => {
  const r = await ctx.cl('POST', `/companies/${ctx.co}/documents`, upload(['ok.pdf', '%PDF fine'], ['virus.pdf', EICAR]), 422);
  assert.equal(r.code, 'virus');
  assert.match(r.error, /virus\.pdf.*Eicar-Test-Signature/);
  const ws = await ctx.acc('GET', `/companies/${ctx.co}`);
  assert.equal(ws.items.length, 1, 'neither file of the upload was stored');
  const log = await ctx.acc('GET', `/companies/${ctx.co}/events?limit=20`);
  assert.ok(log.events.some((e) => e.type === 'virus_blocked' && /virus\.pdf/.test(e.text)));
});

test('while the scanner is down files are accepted as pending, then scanned and blocked if infected', async () => {
  await new Promise((r) => clamd.close(r));
  await ctx.cl('POST', `/companies/${ctx.co}/documents`, upload(['late.pdf', `%PDF ${EICAR}`]), 201);
  let ws = await ctx.acc('GET', `/companies/${ctx.co}`);
  const late = ws.items.find((i) => i.title === 'late');
  assert.equal(late.versions[0].scan_status, 'pending');
  assert.equal(await rescanPending(), 0, 'still down: nothing scanned');
  await startClamd(port);
  await flushEmails(); sentMail.length = 0;
  assert.equal(await rescanPending(), 1);
  await flushEmails();
  ws = await ctx.acc('GET', `/companies/${ctx.co}`);
  assert.equal(ws.items.find((i) => i.id === late.id).versions[0].scan_status, 'infected');
  assert.ok(ws.events.some((e) => e.type === 'virus_found' && e.item_id === late.id));
  const blocked = await ctx.acc('GET', `/items/${late.id}/file`, undefined, 410);
  assert.match(blocked.error, /malware/);
  const to = sentMail.map((m) => m.to_email).sort();
  assert.deepEqual(to, ['daniel@solymar.es', 'elena@voixa.es'], 'both sides are told at once');
});
