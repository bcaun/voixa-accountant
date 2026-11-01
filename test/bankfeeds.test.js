// Open banking: connect a bank, fetch movements as statements, no duplicates, expiry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const booked = [
  { transactionId: 't1', bookingDate: '2026-10-03', valueDate: '2026-10-03', transactionAmount: { amount: '-1210.00', currency: 'EUR' }, creditorName: 'MAKRO AUTOSERVICIO', creditorAccount: { iban: 'ES9121000418450200051332' }, remittanceInformationUnstructured: 'FRA F-2026-08812' },
];
let expired = false;
const gc = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const send = (o, code = 200) => { res.statusCode = code; res.end(JSON.stringify(o)); };
    if (req.url === '/api/v2/token/new/') return send({ access: 'tok', access_expires: 3600 });
    if (req.headers.authorization !== 'Bearer tok') return send({ summary: 'auth' }, 401);
    if (req.url.startsWith('/api/v2/institutions/?country=es')) return send([{ id: 'CAIXABANK_CAIXESBB', name: 'CaixaBank', bic: 'CAIXESBB', logo: '' }]);
    if (req.url === '/api/v2/agreements/enduser/') return send({ id: 'agr1' });
    if (req.url === '/api/v2/requisitions/' && req.method === 'POST') { const b = JSON.parse(body); gc.ref = b.reference; return send({ id: 'req1', link: 'https://bank.test/auth/req1' }); }
    if (req.url === '/api/v2/requisitions/req1/' && req.method === 'GET') return send({ id: 'req1', status: 'LN', accounts: ['acc1'] });
    if (req.url === '/api/v2/requisitions/req1/' && req.method === 'DELETE') return send({});
    if (req.url === '/api/v2/accounts/acc1/details/') return send({ account: { iban: 'ES7620770024003102575766', currency: 'EUR', ownerName: 'SOL Y MAR SL' } });
    if (req.url.startsWith('/api/v2/accounts/acc1/transactions/')) return expired ? send({ summary: 'expired' }, 401) : send({ transactions: { booked, pending: [] } });
    send({ summary: 'not found' }, 404);
  });
}).listen(0);
await new Promise((r) => gc.once('listening', r));

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-bank-'));
delete process.env.ANTHROPIC_API_KEY;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  GOCARDLESS_SECRET_ID: 'id', GOCARDLESS_SECRET_KEY: 'key', GOCARDLESS_API_BASE: `http://127.0.0.1:${gc.address().port}`,
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
after(async () => { server.close(); gc.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

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

test('the client picks their bank and is sent to it to authorise access', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id) values ('elena@voixa.es', 'Elena', 'accountant', $1)`, [f.id]);
  ctx.acc = await as('elena@voixa.es');
  ctx.co = (await ctx.acc('POST', '/companies', { name: 'Sol y Mar SL', nif: 'B56781234', contactEmail: 'daniel@solymar.es' }, 201)).id;
  ctx.cl = await as('daniel@solymar.es');
  assert.equal((await ctx.cl('GET', '/me')).features.bankFeeds, true);
  const list = await ctx.cl('GET', `/companies/${ctx.co}/bank/institutions`);
  assert.equal(list.institutions[0].name, 'CaixaBank');
  const r = await ctx.cl('POST', `/companies/${ctx.co}/bank/connect`, { institutionId: 'CAIXABANK_CAIXESBB' });
  assert.equal(r.url, 'https://bank.test/auth/req1');
  assert.equal((await ctx.cl('GET', `/companies/${ctx.co}/bank`)).connections[0].status, 'pending');
});

test('back from the bank, movements arrive as a statement that is read and matched like an upload', async () => {
  const back = await fetch(`${base}/bank/callback?ref=${gc.ref}`, { redirect: 'manual' });
  assert.equal(back.status, 303);
  assert.equal(back.headers.get('location'), `/#/c/${ctx.co}?bank=ok`);
  await processJobs();
  const conns = (await ctx.cl('GET', `/companies/${ctx.co}/bank`)).connections;
  assert.equal(conns[0].status, 'linked');
  assert.equal(conns[0].accounts[0].iban, 'ES76 …5766');
  const ws = await ctx.acc('GET', `/companies/${ctx.co}`);
  const st = ws.items.find((i) => i.category === 'Bank statement');
  assert.match(st.versions[0].file_name, /^CaixaBank …5766 2026-10-03 to 2026-10-03\.json$/);
  const rec = await ctx.acc('GET', `/companies/${ctx.co}/recognition`);
  assert.equal(rec.extractions.find((e) => e.kind === 'statement').method, 'bankfeed');
  const t = rec.transactions[0];
  assert.deepEqual([t.amount, t.counterparty_name, t.invoice_refs], [-1210, 'MAKRO AUTOSERVICIO', ['F-2026-08812']]);
});

test('later syncs add only new movements', async () => {
  const later = new Date(Date.now() + 13 * 36e5);
  assert.equal(await syncAll(later), 0, 'nothing new: no new statement');
  booked.push({ transactionId: 't2', bookingDate: '2026-10-07', transactionAmount: { amount: '2420.00', currency: 'EUR' }, debtorName: 'HOTEL BRISA SL', remittanceInformationUnstructured: 'Factura 2026/0031' });
  assert.equal(await syncAll(new Date(Date.now() + 26 * 36e5)), 1);
  await processJobs();
  const rec = await ctx.acc('GET', `/companies/${ctx.co}/recognition`);
  assert.equal(rec.transactions.length, 2);
});

test('when the bank access ends, the client is asked to reconnect; a connection can be removed', async () => {
  expired = true;
  await flushEmails(); sentMail.length = 0;
  await syncAll(new Date(Date.now() + 40 * 36e5));
  await flushEmails();
  assert.equal((await ctx.cl('GET', `/companies/${ctx.co}/bank`)).connections[0].status, 'expired');
  assert.ok(sentMail.some((m) => m.to_email === 'daniel@solymar.es' && /Reconnect CaixaBank/.test(m.subject)));
  const id = (await ctx.cl('GET', `/companies/${ctx.co}/bank`)).connections[0].id;
  await ctx.cl('DELETE', `/companies/${ctx.co}/bank/${id}`);
  assert.equal((await ctx.cl('GET', `/companies/${ctx.co}/bank`)).connections.length, 0);
});
