// Open banking through Enable Banking: signed requests (JWT, RS256), the bank's redirect with a code,
// paged movements with debit/credit signs, expiry and removal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP = '103f87d8-0000-4ca3-a89c-2cf8a28e3e56';
const page1 = [
  { entry_reference: 'e1', transaction_amount: { currency: 'EUR', amount: '1210.00' }, credit_debit_indicator: 'DBIT', status: 'BOOK',
    creditor: { name: 'MAKRO AUTOSERVICIO' }, creditor_account: { iban: 'ES9121000418450200051332' }, booking_date: '2026-10-03', value_date: '2026-10-03', remittance_information: ['FRA F-2026-08812'] },
  { entry_reference: 'p1', transaction_amount: { currency: 'EUR', amount: '5.00' }, credit_debit_indicator: 'DBIT', status: 'PDNG', booking_date: '2026-10-09', remittance_information: ['pending'] },
];
const page2 = [
  { entry_reference: 'e2', transaction_amount: { currency: 'EUR', amount: '2420.00' }, credit_debit_indicator: 'CRDT', status: 'BOOK',
    debtor: { name: 'HOTEL BRISA SL' }, booking_date: '2026-10-07', remittance_information: ['Factura 2026/0031'] },
];
const seen = { auth: null, deleted: [] };
let expired = false;
function jwtOk(h = '') {
  const [hd, pl, sig] = h.replace(/^Bearer /, '').split('.');
  if (!sig) return false;
  const head = JSON.parse(Buffer.from(hd, 'base64url')), body = JSON.parse(Buffer.from(pl, 'base64url'));
  return head.alg === 'RS256' && head.kid === APP && body.aud === 'api.enablebanking.com' && body.exp > Date.now() / 1000
    && createVerify('RSA-SHA256').update(`${hd}.${pl}`).verify(publicKey, Buffer.from(sig, 'base64url'));
}
const eb = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const send = (o, code = 200) => { res.statusCode = code; res.end(JSON.stringify(o)); };
    if (!jwtOk(req.headers.authorization)) return send({ error: 'UNAUTHORIZED' }, 401);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/aspsps') return send({ aspsps: u.searchParams.get('country') === 'ES'
      ? [{ name: 'CaixaBank', country: 'ES', logo: '', psu_types: ['business', 'personal'], maximum_consent_validity: 7776000 }, { name: 'Abanca', country: 'ES', psu_types: ['personal'] }] : [] });
    if (u.pathname === '/auth' && req.method === 'POST') { seen.auth = JSON.parse(body); return send({ url: 'https://bank.test/auth/eb1', authorization_id: 'a1' }); }
    if (u.pathname === '/sessions' && req.method === 'POST') {
      if (JSON.parse(body).code !== 'good-code') return send({ error: 'WRONG_CODE' }, 400);
      return send({ session_id: 'sess1', accounts: [{ uid: 'uid-1', account_id: { iban: 'ES7620770024003102575766' }, currency: 'EUR', name: 'Cuenta negocios' }],
        access: { valid_until: new Date(Date.now() + 80 * 864e5).toISOString() } });
    }
    if (u.pathname === '/accounts/uid-1/transactions') {
      if (expired) return send({ error: 'EXPIRED_SESSION', message: 'Session expired' }, 422);
      return u.searchParams.get('continuation_key') === 'k2' ? send({ transactions: page2 }) : send({ transactions: page1, continuation_key: 'k2' });
    }
    if (u.pathname === '/sessions/sess1' && req.method === 'DELETE') { seen.deleted.push('sess1'); return send({}); }
    send({ error: 'NOT_FOUND' }, 404);
  });
}).listen(0);
await new Promise((r) => eb.once('listening', r));

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-eb-'));
await writeFile(path.join(dir, 'eb.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOCARDLESS_SECRET_ID;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  ENABLE_BANKING_APP_ID: APP, ENABLE_BANKING_KEY_FILE: path.join(dir, 'eb.pem'), ENABLE_BANKING_API_BASE: `http://127.0.0.1:${eb.address().port}`,
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { sentMail, flushEmails } = await import('../src/mailer.js');
const { processJobs } = await import('../src/recognition/recognize.js');
const { syncAll } = await import('../src/bankfeeds.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); eb.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

async function as(email) {
  const { rows: [u] } = await pool.query('select id from users where email = $1', [email]);
  const token = new URL(await createLoginLink(u.id)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, p, body, expect = 200) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
const ctx = {};

test('banks are listed, business and personal access apart, and the client is sent to the bank', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country, tier) values ('Voixa', 'ES', 'pro') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id) values ('elena@voixa.es', 'Elena', 'accountant', $1)`, [f.id]);
  ctx.acc = await as('elena@voixa.es');
  ctx.co = (await ctx.acc('POST', '/companies', { name: 'Sol y Mar SL', nif: 'B56781234', contactEmail: 'daniel@solymar.es' }, 201)).id;
  ctx.cl = await as('daniel@solymar.es');
  assert.equal((await ctx.cl('GET', '/me')).features.bankFeeds, true);
  const { institutions } = await ctx.cl('GET', `/companies/${ctx.co}/bank/institutions`);
  assert.deepEqual(institutions.map((i) => [i.id, i.kind]), [['personal:Abanca', undefined], ['business:CaixaBank', 'business'], ['personal:CaixaBank', 'personal']]);
  const r = await ctx.cl('POST', `/companies/${ctx.co}/bank/connect`, { institutionId: 'business:CaixaBank' });
  assert.equal(r.url, 'https://bank.test/auth/eb1');
  assert.deepEqual([seen.auth.aspsp, seen.auth.psu_type, seen.auth.redirect_url, seen.auth.language], [{ name: 'CaixaBank', country: 'ES' }, 'business', 'http://localhost/bank/callback', 'es']);
  assert.ok(new Date(seen.auth.access.valid_until) - Date.now() <= 90 * 864e5);
});

test('a refusal at the bank leaves the connection marked as not authorised', async () => {
  await ctx.cl('POST', `/companies/${ctx.co}/bank/connect`, { institutionId: 'personal:Abanca' });
  const back = await fetch(`${base}/bank/callback?state=${seen.auth.state}&error=access_denied`, { redirect: 'manual' });
  assert.equal(back.headers.get('location'), `/#/c/${ctx.co}?bank=failed`);
  const c = (await ctx.cl('GET', `/companies/${ctx.co}/bank`)).connections.find((x) => x.institution_name === 'Abanca');
  assert.equal(c.status, 'error');
  await ctx.cl('DELETE', `/companies/${ctx.co}/bank/${c.id}`);
});

test('back from the bank with a code: the account is linked and booked movements of every page arrive', async () => {
  const { rows: [conn] } = await pool.query(`select reference from bank_connections where institution_name = 'CaixaBank'`);
  const back = await fetch(`${base}/bank/callback?state=${conn.reference}&code=good-code`, { redirect: 'manual' });
  assert.equal(back.headers.get('location'), `/#/c/${ctx.co}?bank=ok`);
  const again = await fetch(`${base}/bank/callback?state=${conn.reference}&code=good-code`, { redirect: 'manual' });
  assert.equal(again.headers.get('location'), `/#/c/${ctx.co}?bank=ok`, 'reloading the page does not break anything');
  await processJobs();
  const c = (await ctx.cl('GET', `/companies/${ctx.co}/bank`)).connections[0];
  assert.equal(c.status, 'linked');
  assert.ok(new Date(c.expires_at) - Date.now() < 81 * 864e5, 'access ends when the bank says');
  const rec = await ctx.acc('GET', `/companies/${ctx.co}/recognition`);
  const t = rec.transactions.map((x) => [x.amount, x.counterparty_name]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(t, [[-1210, 'MAKRO AUTOSERVICIO'], [2420, 'HOTEL BRISA SL']], 'debits negative, pending left out');
  const ws = await ctx.acc('GET', `/companies/${ctx.co}`);
  assert.match(ws.items.find((i) => i.category === 'Bank statement').versions[0].file_name, /^CaixaBank …5766 2026-10-03 to 2026-10-07\.json$/);
  assert.equal(await syncAll(new Date(Date.now() + 13 * 36e5)), 0, 'nothing twice');
});

test('an expired session asks the client to reconnect; disconnecting closes the session at Enable Banking', async () => {
  expired = true;
  await flushEmails(); sentMail.length = 0;
  await syncAll(new Date(Date.now() + 26 * 36e5));
  await flushEmails();
  const c = (await ctx.cl('GET', `/companies/${ctx.co}/bank`)).connections[0];
  assert.equal(c.status, 'expired');
  assert.ok(sentMail.some((m) => m.to_email === 'daniel@solymar.es' && /Reconnect CaixaBank/.test(m.subject)));
  await ctx.cl('DELETE', `/companies/${ctx.co}/bank/${c.id}`);
  assert.deepEqual(seen.deleted, ['sess1']);
});
