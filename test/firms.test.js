// Several firms on one server, and clients in Italy, France, Germany and Portugal.
// Firms must never see each other's clients; each client's country sets its tax ID rules,
// deadline time zone and how its documents are read. No AI is configured here: everything
// below is read by the national-format parsers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fatturaPA, p7m, ubl, cii, facturX, cfonb120, mt940 } from './fixtures-intl.js';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-firms-'));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost', FIRM_NAME: 'Voixa Accounting',
});

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { sentMail, flushEmails } = await import('../src/mailer.js');
const { processJobs } = await import('../src/recognition/recognize.js');
const { setAiReader } = await import('../src/recognition/ai.js');
setAiReader(null);

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
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
    assert.equal(r.status, expect, `${method} ${p} → ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  };
  return { get: (p, e) => call('GET', p, undefined, e), post: (p, b, e = 200) => call('POST', p, b, e), patch: (p, b, e = 200) => call('PATCH', p, b, e) };
}
const upload = (fields, name, content, type = 'application/octet-stream') => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append('files', new Blob([content], { type }), name);
  return f;
};
async function accountant(email, name, firm, country) {
  const { rows: [f] } = await pool.query('insert into firms (name, country) values ($1, $2) returning id', [firm, country]);
  const { rows: [u] } = await pool.query(`insert into users (email, name, role, firm_id) values ($1, $2, 'accountant', $3) returning id`, [email, name, f.id]);
  return as(await signIn(await createLoginLink(u.id)));
}
async function clientOf(email) {
  const { rows: [u] } = await pool.query('select id from users where email = $1', [email]);
  return as(await signIn(await createLoginLink(u.id)));
}
const events = async (companyId) => (await pool.query('select type, text from events where company_id = $1 order by seq', [companyId])).rows;

const ctx = {};

test('two firms, each with its own country, clients and numbering', async () => {
  ctx.es = await accountant('elena@voixa.es', 'Elena Ruiz', 'Voixa Accounting', 'ES');
  ctx.it = await accountant('giulia@studiorossi.it', 'Giulia Rossi', 'Studio Rossi', 'IT');
  const esCo = await ctx.es.post('/companies', { name: 'Sol y Mar Hospitality SL', nif: 'B56781234' }, 201);
  const itCo = await ctx.it.post('/companies', { name: 'Trattoria Bella Vista S.r.l.', nif: 'IT01234567897', city: 'Milano', contactEmail: 'marco@bellavista.it', contactName: 'Marco Bianchi' }, 201);
  ctx.esCo = esCo.id; ctx.itCo = itCo.id;
  const meIt = await ctx.it.get('/me');
  assert.equal(meIt.firm, 'Studio Rossi');
  assert.equal(meIt.firmInfo.country, 'IT');
  assert.deepEqual(meIt.companies.map((c) => [c.no, c.country, c.nif]), [[1, 'IT', '01234567897']]);
  assert.ok(meIt.countries.find((c) => c.code === 'IT').presets.some((p) => /F24/.test(p.title)));
  // numbering is per firm: both firms have a client #1
  assert.equal((await ctx.es.get('/me')).companies[0].no, 1);
});

test('a firm never sees, opens or is notified about another firm’s clients', async () => {
  assert.deepEqual((await ctx.es.get('/me')).companies.map((c) => c.id), [ctx.esCo]);
  assert.deepEqual((await ctx.es.get('/overview')).companies.map((c) => c.id), [ctx.esCo]);
  await ctx.es.get(`/companies/${ctx.itCo}`, 404);
  await ctx.es.get(`/companies/${ctx.itCo}/export.csv`, 404);
  await ctx.es.post(`/companies/${ctx.itCo}/requests`, { title: 'x', due: '2026-12-01' }, 404);
  await ctx.it.get(`/companies/${ctx.esCo}`, 404);
  const usage = await ctx.es.get('/ai-usage');
  assert.ok(usage.companies.every((c) => c.company_id === ctx.esCo));

  await flushEmails();
  sentMail.length = 0;
  ctx.marco = await clientOf('marco@bellavista.it');
  await ctx.marco.post(`/companies/${ctx.itCo}/documents`, upload({ category: 'Other' }, 'Contratto.pdf', '%PDF-1.4 contratto'), 201);
  await flushEmails();
  const to = sentMail.map((m) => m.to_email);
  assert.ok(to.includes('giulia@studiorossi.it'));
  assert.ok(!to.includes('elena@voixa.es'), 'the Spanish firm must not hear about an Italian firm’s client');
  assert.match(sentMail.find((m) => m.to_email === 'giulia@studiorossi.it').body_text, /Studio Rossi · Pescada/);
});

test('tax IDs are checked against the client’s country', async () => {
  await ctx.it.post('/companies', { name: 'Bad P.IVA', nif: '12345678901' }, 400);
  const fr = await ctx.it.post('/companies', { name: 'Boulangerie Martin SAS', nif: 'FR44732829320', country: 'FR' }, 201);
  const de = await ctx.it.post('/companies', { name: 'Bäckerei Schmidt GmbH', nif: 'DE811907980', country: 'DE' }, 201);
  const pt = await ctx.it.post('/companies', { name: 'Silva & Filhos Lda', nif: '501964843', country: 'PT' }, 201);
  await ctx.it.post('/companies', { name: 'Wrong NIF', nif: '501964844', country: 'PT' }, 400);
  await ctx.it.post('/companies', { name: 'Nowhere', country: 'XX' }, 400);
  Object.assign(ctx, { frCo: fr.id, deCo: de.id, ptCo: pt.id });
  const ws = await ctx.it.get(`/companies/${ctx.ptCo}`);
  assert.equal(ws.company.country, 'PT');
  assert.equal(ws.company.tz, 'Europe/Lisbon');
  assert.equal(ws.company.taxIdLabel, 'NIF / NIPC');
  assert.equal(ws.company.no, 4);
});

test('deadlines are counted in the client’s time zone, and can fall in the second month after the period', async () => {
  // Portugal: the quarterly VAT return is due on the 20th of the second month after the quarter, at 23:59:59 Lisbon time
  await ctx.it.post(`/companies/${ctx.ptCo}/obligations`, { kind: 'report', title: 'Declaração periódica de IVA', frequency: 'quarterly', dueDay: 20, monthOffset: 2, leadDays: 60 }, 201);
  const ws = await ctx.it.get(`/companies/${ctx.ptCo}`);
  assert.match(ws.obligations[0].description, /day 20 of the second month after the quarter/);
  const due = ws.items.find((i) => i.obligation_id === ws.obligations[0].id).due_at;
  assert.equal(new Date(due).toISOString(), '2026-11-20T23:59:59.000Z'); // Lisbon is UTC+0 in November
  // Italy: a request due on 5 December ends at 23:59:59 Rome time
  await ctx.it.post(`/companies/${ctx.itCo}/requests`, { title: 'Estratti conto novembre', due: '2026-12-05' }, 201);
  const req = (await ctx.it.get(`/companies/${ctx.itCo}`)).items.find((i) => i.kind === 'request');
  assert.equal(new Date(req.due_at).toISOString(), '2026-12-05T22:59:59.000Z');
});

test('an Italian FatturaPA, plain and signed (.p7m), is read without AI and matched to the bank payment', async () => {
  await ctx.marco.post(`/companies/${ctx.itCo}/documents`, upload({ category: 'Invoice' }, 'IT00743110157_00001.xml', fatturaPA(), 'text/xml'), 201);
  await ctx.marco.post(`/companies/${ctx.itCo}/documents`, upload({ category: 'Invoice' }, 'IT00743110157_00002.xml.p7m', p7m(fatturaPA('2026/146', '500.00'))), 201);
  const csv = 'Data operazione;Data valuta;Descrizione;Dare;Avere\n05/10/2026;05/10/2026;BONIFICO SEPA A FAVORE DI ROSSI FORNITURE SRL CAUSALE FATTURA N. 2026/145;1.220,00;\n';
  await ctx.marco.post(`/companies/${ctx.itCo}/documents`, upload({ category: 'Bank statement' }, 'estratto_ottobre.csv', csv, 'text/csv'), 201);
  await processJobs();
  const rec = await ctx.it.get(`/companies/${ctx.itCo}/recognition`);
  const nums = rec.invoices.map((d) => d.invoice_number).sort();
  assert.deepEqual(nums, ['2026/145', '2026/146']);
  const inv = rec.invoices.find((d) => d.invoice_number === '2026/145');
  assert.equal(inv.direction, 'received');
  assert.equal(inv.total_amount, 1220);
  assert.ok(rec.extractions.filter((e) => e.kind === 'invoice').every((e) => e.method === 'fatturapa'));
  assert.equal(rec.matches.length, 1);
  assert.equal(rec.matches[0].invoice_item_id, inv.item_id);
  assert.ok((await events(ctx.itCo)).some((e) => e.type === 'invoice_recognised' && /Source: FatturaPA e-invoice/.test(e.text)));
});

test('France: a Factur-X PDF and a CFONB 120 statement', async () => {
  await ctx.it.post(`/companies/${ctx.frCo}/members`, { email: 'claire@boulangerie-martin.fr', name: 'Claire Martin' }, 201);
  const claire = await clientOf('claire@boulangerie-martin.fr');
  await claire.post(`/companies/${ctx.frCo}/documents`, upload({ category: 'Invoice' }, 'FA-2026-0091.pdf', facturX(), 'application/pdf'), 201);
  await claire.post(`/companies/${ctx.frCo}/documents`, upload({ category: 'Bank statement' }, 'releve.cfo', cfonb120, 'text/plain'), 201);
  await processJobs();
  const rec = await ctx.it.get(`/companies/${ctx.frCo}`).then(() => ctx.it.get(`/companies/${ctx.frCo}/recognition`));
  const st = rec.extractions.find((e) => e.kind === 'statement');
  assert.equal(st.method, 'cfonb120');
  assert.equal(st.summary.balance_check, 'ok');
  assert.equal(rec.invoices[0].invoice_number, 'FA-2026-0091');
  assert.equal(rec.extractions.find((e) => e.kind === 'invoice').method, 'facturx');
  assert.equal(rec.matches.length, 1);
});

test('Germany: an XRechnung (UBL) and an MT940 statement', async () => {
  await ctx.it.post(`/companies/${ctx.deCo}/members`, { email: 'jonas@baeckerei-schmidt.de', name: 'Jonas Schmidt' }, 201);
  const jonas = await clientOf('jonas@baeckerei-schmidt.de');
  await jonas.post(`/companies/${ctx.deCo}/documents`, upload({ category: 'Invoice' }, 'xrechnung.xml', ubl, 'text/xml'), 201);
  await jonas.post(`/companies/${ctx.deCo}/documents`, upload({ category: 'Bank statement' }, 'auszug.sta', mt940, 'text/plain'), 201);
  await processJobs();
  const rec = await ctx.it.get(`/companies/${ctx.deCo}/recognition`);
  const st = rec.extractions.find((e) => e.kind === 'statement');
  assert.equal(st.method, 'mt940');
  assert.equal(st.summary.balance_check, 'ok');
  const tx = rec.transactions.find((t) => t.amount === -1190);
  assert.equal(tx.counterparty_name, 'MUELLER BUEROBEDARF GMBH');
  assert.deepEqual(tx.invoice_refs, ['RE-2026-0042']);
  assert.equal(rec.invoices[0].direction, 'received');
  assert.equal(rec.matches.length, 1);
});

test('the firm can rename itself and change its default country', async () => {
  await ctx.it.patch('/firm', { name: 'Studio Rossi & Associati', country: 'IT' });
  await ctx.it.patch('/firm', { name: 'x', country: 'US' }, 400);
  await ctx.marco.patch('/firm', { name: 'hijack', country: 'IT' }, 403);
  assert.equal((await ctx.it.get('/me')).firm, 'Studio Rossi & Associati');
  assert.equal((await ctx.es.get('/me')).firm, 'Voixa Accounting');
  // a company without a country inherits the firm's
  const co = await ctx.it.post('/companies', { name: 'Pizzeria Napoli' }, 201);
  assert.equal((await ctx.it.get(`/companies/${co.id}`)).company.country, 'IT');
});
