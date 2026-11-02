// Web Push: devices subscribe, notifications follow the same rules as instant emails,
// and subscriptions the push service reports as gone are removed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// a stand-in push service (what Apple, Google or Mozilla run), over HTTPS with a throwaway certificate
const certDir = await mkdtemp(path.join(tmpdir(), 'pescada-push-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '1', '-subj', '/CN=localhost'], { cwd: certDir, stdio: 'ignore' });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // only for this stand-in
const received = [];
let gone = false;
const pushSrv = https.createServer({ key: await readFile(path.join(certDir, 'k.pem')), cert: await readFile(path.join(certDir, 'c.pem')) }, (req, res) => {
  const chunks = []; req.on('data', (d) => chunks.push(d));
  req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = gone ? 410 : 201; res.end(); });
}).listen(0);
await new Promise((r) => pushSrv.once('listening', r));
const endpoint = `https://127.0.0.1:${pushSrv.address().port}/push/abc`;
const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const subscription = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-pushdata-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { flushEmails } = await import('../src/mailer.js');
const { flushPush } = await import('../src/push.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); pushSrv.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); await rm(certDir, { recursive: true, force: true }); });

async function as(email) {
  const { rows: [u] } = await pool.query('select id from users where email = $1', [email]);
  const token = new URL(await createLoginLink(u.id)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, p, body, expect = 200) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body instanceof FormData) opt.body = body; else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
const ctx = {};

test('the installed app files are served: manifest, service worker, icons', async () => {
  const m = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(m.status, 200);
  assert.equal((await m.json()).display, 'standalone');
  assert.match(await (await fetch(`${base}/sw.js`)).text(), /addEventListener\('push'/);
  assert.equal((await fetch(`${base}/icons/apple-touch-icon.png`)).headers.get('content-type'), 'image/png');
});

test('a device subscribes with the server key, and only valid subscriptions are accepted', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id, notify_mode) values ('elena@voixa.es', 'Elena', 'accountant', $1, 'instant')`, [f.id]);
  ctx.acc = await as('elena@voixa.es');
  const { key } = await ctx.acc('GET', '/push/key');
  assert.equal(Buffer.from(key, 'base64url').length, 65, 'an uncompressed P-256 public key');
  assert.equal((await ctx.acc('GET', '/push/key')).key, key, 'the same key every time');
  await ctx.acc('POST', '/push/subscribe', { subscription: { endpoint: 'http://insecure', keys: {} } }, 400);
  await ctx.acc('POST', '/push/subscribe', { subscription });
});

test('a new document reaches the accountant as an encrypted push, signed with the server key', async () => {
  ctx.co = (await ctx.acc('POST', '/companies', { name: 'Sol y Mar SL', contactEmail: 'daniel@solymar.es' }, 201)).id;
  const cl = await as('daniel@solymar.es');
  const f = new FormData(); f.append('category', 'Other'); f.append('files', new Blob(['%PDF x']), 'factura.pdf');
  await cl('POST', `/companies/${ctx.co}/documents`, f, 201);
  await flushEmails(); await flushPush();
  assert.equal(received.length, 1);
  const r = received[0];
  assert.equal(r.url, '/push/abc');
  assert.equal(r.headers['content-encoding'], 'aes128gcm', 'the payload is encrypted for the device');
  assert.match(r.headers.authorization, /^vapid t=.+, k=/);
  assert.ok(r.body.length > 50 && !r.body.includes(Buffer.from('factura')), 'nothing readable on the way');
});

test('a subscription the push service no longer knows is removed', async () => {
  gone = true;
  await pool.query(`insert into push_messages (user_id, title) select id, 'x' from users where email = 'elena@voixa.es'`);
  await flushPush();
  const { rows } = await pool.query('select count(*)::int as n from push_subscriptions');
  assert.equal(rows[0].n, 0);
});
