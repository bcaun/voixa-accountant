// Exports for accounting software: invoice register, bank movements and DATEV.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ubl, mt940 } from './fixtures-intl.js';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-exp-'));
delete process.env.ANTHROPIC_API_KEY;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { processJobs } = await import('../src/recognition/recognize.js');

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
    if (raw) { assert.equal(res.status, expect); return { type: res.headers.get('content-type'), name: res.headers.get('content-disposition'), body: Buffer.from(await res.arrayBuffer()) }; }
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
const file = (cat, name, content) => { const f = new FormData(); f.append('category', cat); f.append('files', new Blob([content]), name); return f; };

test('a German client: invoice register, bank movements and a DATEV booking batch', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Kanzlei Weber', 'DE') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id) values ('anna@weber.de', 'Anna', 'accountant', $1)`, [f.id]);
  const acc = await as('anna@weber.de');
  const co = (await acc('POST', '/companies', { name: 'Bäckerei Schmidt GmbH', nif: 'DE811907980', contactEmail: 'jonas@schmidt.de' }, 201)).id;
  const cl = await as('jonas@schmidt.de');
  await cl('POST', `/companies/${co}/documents`, file('Invoice', 'xrechnung.xml', ubl), 201);
  await cl('POST', `/companies/${co}/documents`, file('Bank statement', 'auszug.sta', mt940), 201);
  await processJobs();
  const rec = await acc('GET', `/companies/${co}/recognition`);
  await acc('POST', `/companies/${co}/matches/${rec.matches[0].id}/confirm`);

  const inv = await acc('GET', `/companies/${co}/accounting-export?kind=invoices&from=2026-01-01&to=2026-12-31`, undefined, 200, true);
  const invText = inv.body.toString('utf8');
  assert.match(invText.split('\r\n')[0], /rechnungsnummer;rechnungsdatum/);
  assert.match(invText, /RE-2026-0042;2026-10-02;2026-10-16;received;Müller Bürobedarf GmbH;DE136695976/);
  assert.match(invText, /;1000,00;190,00;1190,00;2026-10-03;-1190,00;/, 'German decimals, with the confirmed payment');

  const bank = await acc('GET', `/companies/${co}/accounting-export?kind=bank`, undefined, 200, true);
  assert.match(bank.body.toString('utf8'), /2026-10-03;2026-10-03;-1190,00;EUR;MUELLER BUEROBEDARF GMBH;.*RE-2026-0042;confirmed/);

  const datev = await acc('GET', `/companies/${co}/accounting-export?kind=datev&consultant=29098&client=55003&from=2026-01-01&to=2026-12-31`, undefined, 200, true);
  const lines = datev.body.toString('latin1').split('\r\n');
  assert.match(lines[0], /^"EXTF";700;21;"Buchungsstapel";13;\d+;;"RE";"Pescada";"";29098;55003;20260101;4;20260101;20261231;/);
  assert.match(lines[1], /^Umsatz \(ohne Soll\/Haben-Kz\);Soll\/Haben-Kennzeichen;WKZ Umsatz/);
  assert.equal(lines[2], '1190,00;"H";"EUR";;;"";1200;70000;"";0310;"RE-2026-0042";"";;"Müller Bürobedarf GmbH"');
  assert.match(datev.name, /EXTF_Buchungsstapel_1_2026\.csv/);

  // DATEV is only offered for German clients
  const es = (await acc('POST', '/companies', { name: 'Sol SL', country: 'ES' }, 201)).id;
  await acc('GET', `/companies/${es}/accounting-export?kind=datev`, undefined, 400);
  await cl('GET', `/companies/${co}/accounting-export?kind=invoices`, undefined, 403);
});
