// End-to-end: statements and invoices are read after upload, and payments are matched to invoices.
// The AI reader is replaced by a stub; Norma 43 and CSV go through the real parsers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SAMPLE_N43 } from './fixtures.js';

const dir = await mkdtemp(path.join(tmpdir(), 'voixa-rec-'));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
});

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { sentMail, flushEmails } = await import('../src/mailer.js');
const { processJobs } = await import('../src/recognition/recognize.js');
const { setAiReader } = await import('../src/recognition/ai.js');

const INVOICES = {
  'Makro_F-2026-08812.pdf': { invoice_number: 'F-2026-08812', issue_date: '2026-09-01', due_date: '2026-09-30', issuer_name: 'Makro Autoservicio Mayorista SA',
    issuer_tax_id: 'A28647451', recipient_name: 'Sol y Mar Hospitality SL', recipient_tax_id: 'B56781234', currency: 'EUR', net_amount: 1000, tax_amount: 210, total_amount: 1210 },
  'Factura_2026-0031_Brisa.pdf': { invoice_number: '2026/0031', issue_date: '2026-09-05', due_date: null, issuer_name: 'Sol y Mar Hospitality SL',
    issuer_tax_id: 'B56781234', recipient_name: 'Hotel Brisa SL', recipient_tax_id: 'B12345674', currency: 'EUR', net_amount: 2000, tax_amount: 420, total_amount: 2420 },
};
const aiCalls = [];
setAiReader(async (kind, file) => {
  aiCalls.push([kind, file.type, file.name]);
  const inv = INVOICES[file.name];
  return { model: 'stub', data: inv ? { is_invoice: true, contract_number: null, ...inv } : { is_invoice: false } };
});

let server, base;
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
  return r.headers.get('set-cookie').split(';')[0];
}
function as(cookie) {
  const call = async (method, p, body, expect = 200) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(`${base}/api${p}`, opt);
    const data = await r.json().catch(() => ({}));
    assert.equal(r.status, expect, `${method} ${p} → ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  };
  return { get: (p, e) => call('GET', p, undefined, e), post: (p, b, e) => call('POST', p, b, e) };
}
const upload = (category, name, content, type = 'application/pdf') => {
  const f = new FormData();
  f.append('category', category);
  f.append('files', new Blob([content], { type }), name);
  return f;
};

const ctx = {};
const rec = () => ctx.acc.get(`/companies/${ctx.co}/recognition`);
const events = async () => (await ctx.acc.get(`/companies/${ctx.co}`)).events;

test('setup: accountant, client company with its NIF, client contact', async () => {
  const { rows: [acc] } = await pool.query(`insert into users (email, name, role) values ('elena@voixa.es', 'Elena Ruiz', 'accountant') returning *`);
  ctx.acc = as(await signIn(await createLoginLink(acc.id)));
  ctx.co = (await ctx.acc.post('/companies', { name: 'Sol y Mar Hospitality SL', nif: 'B56781234', contactEmail: 'daniel@solymar.es', contactName: 'Daniel Moreau' }, 201)).id;
  await flushEmails();
  ctx.daniel = as(await signIn(/https?:\/\/\S+token=\S+/.exec(sentMail.find((m) => m.to_email === 'daniel@solymar.es').body_text)[0]));
});

test('an uploaded invoice is read and its direction is worked out from the company NIF', async () => {
  await ctx.daniel.post(`/companies/${ctx.co}/documents`, upload('Invoice', 'Makro_F-2026-08812.pdf', '%PDF-1.4 makro'), 201);
  await processJobs(); await processJobs();
  const r = await rec();
  assert.equal(r.invoices.length, 1);
  assert.equal(r.invoices[0].invoice_number, 'F-2026-08812');
  assert.equal(r.invoices[0].direction, 'received');
  assert.equal(r.invoices[0].total_amount, 1210);
  assert.deepEqual(aiCalls[0], ['invoice', 'pdf', 'Makro_F-2026-08812.pdf']);
  assert.ok((await events()).some((e) => e.type === 'invoice_recognised' && /F-2026-08812/.test(e.text)));
});

test('a Norma 43 statement is parsed without AI and payments are matched to invoices', async () => {
  const before = aiCalls.length;
  await ctx.daniel.post(`/companies/${ctx.co}/documents`, upload('Bank statement', 'extracto_2026-09.n43', SAMPLE_N43, 'text/plain'), 201);
  await processJobs(); await processJobs();
  assert.equal(aiCalls.length, before, 'structured formats never go to the AI reader');
  const r = await rec();
  const st = r.extractions.find((e) => e.kind === 'statement');
  assert.equal(st.status, 'done');
  assert.equal(st.method, 'norma43');
  assert.equal(st.summary.balance_check, 'ok');
  assert.equal(r.transactions.length, 2);
  const out = r.transactions.find((t) => t.amount < 0);
  assert.deepEqual(out.invoice_refs, ['F-2026-08812']);
  assert.equal(out.counterparty_name, 'MAKRO AUTOSERV');
  assert.equal(out.counterparty_tax_id, 'A28647451');
  const inn = r.transactions.find((t) => t.amount > 0);
  assert.deepEqual(inn.contract_refs, ['CT-2025-014']);
  assert.ok(inn.invoice_refs.includes('2026/0031'));
  const makro = r.invoices[0].item_id;
  const m = r.matches.find((x) => x.invoice_item_id === makro);
  assert.ok(m, 'payment matched to the Makro invoice');
  assert.equal(m.transaction_id, out.id);
  assert.ok(m.score >= 90);
  assert.ok((await events()).some((e) => e.type === 'statement_recognised' && /2 transactions/.test(e.text)));
});

test('an invoice uploaded after the statement is matched to the payment already there', async () => {
  await ctx.daniel.post(`/companies/${ctx.co}/documents`, upload('Invoice', 'Factura_2026-0031_Brisa.pdf', '%PDF-1.4 brisa'), 201);
  await processJobs(); await processJobs();
  const r = await rec();
  const brisa = r.invoices.find((i) => i.invoice_number === '2026/0031');
  assert.equal(brisa.direction, 'issued');
  const m = r.matches.find((x) => x.invoice_item_id === brisa.item_id);
  assert.ok(m, 'incoming payment matched to the sales invoice');
  assert.equal(r.transactions.find((t) => t.id === m.transaction_id).amount, 2420);
});

test('only accountants decide on matches, and decisions are logged', async () => {
  const r = await rec();
  const [m1, m2] = r.matches;
  await ctx.daniel.post(`/companies/${ctx.co}/matches/${m1.id}/confirm`, {}, 403);
  await ctx.acc.post(`/companies/${ctx.co}/matches/${m1.id}/confirm`, {});
  await ctx.acc.post(`/companies/${ctx.co}/matches/${m1.id}/confirm`, {}, 409);
  await ctx.acc.post(`/companies/${ctx.co}/matches/${m2.id}/reject`, {});
  const after = await rec();
  assert.equal(after.matches.find((m) => m.id === m1.id).status, 'confirmed');
  assert.ok(!after.matches.some((m) => m.id === m2.id), 'rejected matches are hidden');
  const ev = await events();
  assert.ok(ev.some((e) => e.type === 'payment_confirmed' && /Elena Ruiz confirmed/.test(e.text)));
  assert.ok(ev.some((e) => e.type === 'payment_rejected'));
});

test('a CSV uploaded as "Other" can be read as a statement on request', async () => {
  const csv = 'Fecha;Concepto;Importe\n20/09/2026;RECIBO IBERDROLA CONTRATO 0034-55;-605,00\n';
  await ctx.daniel.post(`/companies/${ctx.co}/documents`, upload('Other', 'movimientos.csv', csv, 'text/csv'), 201);
  await processJobs();
  const ws = await ctx.acc.get(`/companies/${ctx.co}`);
  const item = ws.items.find((i) => i.versions[0]?.file_name === 'movimientos.csv');
  assert.ok(!(await rec()).extractions.some((e) => e.item_id === item.id), 'not read automatically');
  await ctx.acc.post(`/items/${item.id}/recognise`, { as: 'statement' }, 202);
  await processJobs();
  const r = await rec();
  const ex = r.extractions.find((e) => e.item_id === item.id);
  assert.equal(ex.method, 'csv');
  assert.deepEqual(r.transactions.find((t) => t.item_id === item.id).contract_refs, ['0034-55']);
});

test('files that cannot be read are reported in the log, with what to do instead', async () => {
  await ctx.daniel.post(`/companies/${ctx.co}/documents`, upload('Bank statement', 'extracto.xlsx', Buffer.from('504b030414000000', 'hex')), 201);
  await processJobs();
  setAiReader(null);
  await ctx.daniel.post(`/companies/${ctx.co}/documents`, upload('Invoice', 'scan.pdf', '%PDF-1.4 scan'), 201);
  await processJobs();
  const r = await rec();
  const failed = r.extractions.filter((e) => e.status === 'unsupported');
  assert.equal(failed.length, 2);
  assert.ok(failed.some((e) => /Export the statement as CSV, Norma 43/.test(e.error)));
  assert.ok(failed.some((e) => /ANTHROPIC_API_KEY/.test(e.error)));
  assert.equal((await events()).filter((e) => e.type === 'recognition_failed').length, 2);
});

test('the evidence log still verifies after recognition and matching', async () => {
  const v = await ctx.acc.get(`/companies/${ctx.co}/verify`);
  assert.equal(v.ok, true);
});
