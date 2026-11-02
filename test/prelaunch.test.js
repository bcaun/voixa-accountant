// Before launch: importing clients, bulk requests, preview, new-device warnings, support,
// passkeys and sign-in with Google / Microsoft (against a stand-in provider).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// a stand-in OpenID provider: it hands back an ID token with whatever claims the test sets
let nextClaims = {};
const idp = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const p = new URLSearchParams(body);
    if (!p.get('code_verifier') || p.get('code') !== 'good-code') { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    res.end(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 300, ...nextClaims })}.sig` }));
  });
}).listen(0);
await new Promise((r) => idp.once('listening', r));
const IDP = `http://127.0.0.1:${idp.address().port}`;

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-pre-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  SUPPORT_EMAIL: 'support@pescada.test',
  GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret', GOOGLE_AUTH_URL: `${IDP}/auth`, GOOGLE_TOKEN_URL: `${IDP}/token`,
  MICROSOFT_CLIENT_ID: 'ms-client', MICROSOFT_CLIENT_SECRET: 'ms-secret', MICROSOFT_AUTH_URL: `${IDP}/auth`, MICROSOFT_TOKEN_URL: `${IDP}/token`,
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
after(async () => { server.close(); idp.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
async function cookieFor(email, ua = MAC) {
  const { rows: [u] } = await pool.query('select id from users where email = $1', [email]);
  const token = new URL(await createLoginLink(u.id)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', headers: { 'User-Agent': ua }, body: new URLSearchParams({ token }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const client = (cookie) => async (method, p, body, expect = 200) => {
  const opt = { method, headers: { cookie, 'X-Voixa': '1', 'User-Agent': MAC } };
  if (body instanceof FormData) opt.body = body; else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(`${base}/api${p}`, opt);
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const ctx = {};

test('setup: a firm and its accountant', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country, tier) values ('Voixa', 'ES', 'pro') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id, firm_role) values ('elena@voixa.es', 'Elena', 'accountant', $1, 'admin')`, [f.id]);
  ctx.firm = f.id;
  ctx.cookie = await cookieFor('elena@voixa.es');
  ctx.acc = client(ctx.cookie);
});

test('clients are imported from a CSV: checked first, then created, duplicates and mistakes skipped', async () => {
  await ctx.acc('POST', '/companies', { name: 'Taller Ruiz SL', nif: 'B12345674' }, 201);
  const csv = '﻿Razón social;NIF;Ciudad;País;Persona de contacto;Correo electrónico\r\n'
    + 'Sol y Mar Hospitality SL;B56781234;Valencia;España;Daniel Moreau;daniel@solymar.es\r\n'
    + '"Bottega Verdi, Srl";01234567897;Milano;IT;;\r\n'
    + 'Taller Ruiz e Hijos;B-12345674;Madrid;;;\r\n'
    + 'Mal NIF SL;B1234;;;;\r\n'
    + 'Sol y Mar (copy);ESB56781234;;;;\r\n'
    + ';;;;;\r\n';
  const plan = await ctx.acc('POST', '/companies/import', { csv });
  assert.deepEqual(plan.rows.map((r) => r.status), ['ok', 'ok', 'duplicate', 'error', 'duplicate']);
  assert.equal(plan.rows[1].country, 'IT');
  assert.match(plan.rows[4].message, /line 2/);
  assert.equal((await ctx.acc('GET', '/me')).companies.length, 1, 'the check writes nothing');
  await flushEmails(); sentMail.length = 0;
  const done = await ctx.acc('POST', '/companies/import', { csv, commit: true, invite: true });
  assert.equal(done.rows.filter((r) => r.status === 'created').length, 2);
  assert.equal((await ctx.acc('GET', '/me')).companies.length, 3);
  await flushEmails();
  assert.ok(sentMail.some((m) => m.to_email === 'daniel@solymar.es'), 'the contact is invited');
  assert.equal((await ctx.acc('POST', '/companies/import', { csv: 'Foo;Bar\r\n1;2\r\n' }, 400)).error.includes('name'), true);
});

test('one request goes to several clients, each with its own item and email', async () => {
  const cos = (await ctx.acc('GET', '/me')).companies;
  const r = await ctx.acc('POST', '/requests/bulk', { title: 'Invoices, October', due: '2026-12-10', companyIds: cos.map((c) => c.id) });
  assert.deepEqual([r.sent, r.failed.length], [3, 0]);
  for (const c of cos) assert.ok((await ctx.acc('GET', `/companies/${c.id}`)).items.some((i) => i.kind === 'request' && i.title === 'Invoices, October'));
  await ctx.acc('POST', '/requests/bulk', { title: 'x', due: '2026-12-10', companyIds: [] }, 400);
});

test('a PDF can be shown inside the app; other files stay sandboxed', async () => {
  const co = (await ctx.acc('GET', '/me')).companies.find((c) => c.name === 'Sol y Mar Hospitality SL').id;
  const daniel = client(await cookieFor('daniel@solymar.es'));
  const f = new FormData(); f.append('category', 'Other'); f.append('files', new Blob(['%PDF-1.4 x'], { type: 'application/pdf' }), 'x.pdf');
  await daniel('POST', `/companies/${co}/documents`, f, 201);
  const it = (await ctx.acc('GET', `/companies/${co}`)).items.find((i) => i.title === 'x');
  const get = (q) => fetch(`${base}/api/items/${it.id}/file?v=1${q}`, { headers: { cookie: ctx.cookie, 'X-Voixa': '1' } });
  assert.equal((await get('&preview=1')).headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal((await get('')).headers.get('content-security-policy'), 'sandbox');
});

test('a sign-in from a new device is reported by email, and its link signs out everywhere', async () => {
  await flushEmails(); sentMail.length = 0;
  const other = await cookieFor('elena@voixa.es', WIN);
  await flushEmails();
  const warn = sentMail.find((m) => m.kind === 'signin_alert' || /New sign-in/.test(m.subject));
  assert.ok(warn, 'a warning is sent');
  assert.match(warn.body_text, /Chrome · Windows/);
  sentMail.length = 0;
  await cookieFor('elena@voixa.es', WIN);
  await flushEmails();
  assert.equal(sentMail.length, 0, 'a known device is not reported again');
  const token = new URL(/https?:\/\/\S+revoke\?token=\S+/.exec(warn.body_text)[0]).searchParams.get('token');
  const page = await fetch(`${base}/auth/revoke?token=${token}`);
  assert.match(await page.text(), /Sign out everywhere/);
  const r = await fetch(`${base}/auth/revoke`, { method: 'POST', body: new URLSearchParams({ token }) });
  assert.equal(r.status, 200);
  await client(other)('GET', '/me', undefined, 401);
  await ctx.acc('GET', '/me', undefined, 401);
  assert.equal((await fetch(`${base}/auth/revoke`, { method: 'POST', body: new URLSearchParams({ token }) })).status, 400, 'once only');
  ctx.cookie = await cookieFor('elena@voixa.es');
  ctx.acc = client(ctx.cookie);
});

test('support messages reach the support address with the sender as reply-to', async () => {
  sentMail.length = 0;
  await ctx.acc('POST', '/support', { message: 'The import button does nothing.', page: '#/' });
  const m = sentMail.find((x) => x.to_email === 'support@pescada.test');
  assert.ok(m);
  assert.equal(m.reply_to, 'elena@voixa.es');
  assert.match(m.body_text, /Firm: Voixa \(ES\)/);
});

test('passkeys: options are issued, and answers that do not check out are refused', async () => {
  const reg = await ctx.acc('POST', '/passkeys/options', {});
  assert.equal(reg.options.rp.id, 'localhost');
  assert.ok(reg.options.challenge && reg.challengeId);
  await ctx.acc('POST', '/passkeys', { challengeId: reg.challengeId, response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }, 400);
  await ctx.acc('POST', '/passkeys', { challengeId: reg.challengeId, response: {} }, 400); // the challenge was used up
  const anon = client('');
  const auth = await anon('POST', '/auth/passkey/options', {});
  assert.deepEqual(auth.options.allowCredentials, []);
  const r = await anon('POST', '/auth/passkey', { challengeId: auth.challengeId, response: { id: 'unknown', rawId: 'unknown', type: 'public-key', response: {} } }, 400);
  assert.match(r.error, /not registered/);
  assert.deepEqual(await anon('GET', '/auth/providers'), { google: true, microsoft: true, passkeys: true });
});

const startAt = async (provider, cookie, mode = '') => {
  const r = await fetch(`${base}/auth/oauth/${provider}/start${mode}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  assert.equal(r.status, 303);
  const u = new URL(r.headers.get('location'));
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  return u;
};
const callback = (provider, state, cookie) => fetch(`${base}/auth/oauth/${provider}/callback?code=good-code&state=${state}`, { redirect: 'manual', headers: { 'User-Agent': MAC, ...(cookie ? { cookie } : {}) } });

test('Google: a verified Google address that is an existing person signs in and links itself', async () => {
  const u = await startAt('google');
  nextClaims = { iss: 'https://accounts.google.com', aud: 'g-client', sub: 'g-123', email: 'elena@voixa.es', email_verified: true, nonce: u.searchParams.get('nonce') };
  const r = await callback('google', u.searchParams.get('state'));
  assert.equal(r.status, 303);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await client(cookie)('GET', '/me')).user.email, 'elena@voixa.es');
  assert.equal((await ctx.acc('GET', '/identities')).identities[0].provider, 'google');
  // a reused state, or a token for another app, is refused
  assert.equal((await callback('google', u.searchParams.get('state'))).status, 400);
  const u2 = await startAt('google');
  nextClaims = { ...nextClaims, aud: 'someone-else', nonce: u2.searchParams.get('nonce') };
  assert.equal((await callback('google', u2.searchParams.get('state'))).status, 400);
});

test('Microsoft: never matched by email; linked from the account, then it signs in', async () => {
  const tid = '11111111-2222-3333-4444-555555555555';
  let u = await startAt('microsoft');
  nextClaims = { iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, aud: 'ms-client', sub: 'ms-abc', email: 'elena@voixa.es', nonce: u.searchParams.get('nonce') };
  let r = await callback('microsoft', u.searchParams.get('state'));
  assert.equal(r.status, 403);
  assert.match(await r.text(), /not linked/);
  u = await startAt('microsoft', ctx.cookie, '?mode=link');
  nextClaims.nonce = u.searchParams.get('nonce');
  r = await callback('microsoft', u.searchParams.get('state'), ctx.cookie);
  assert.equal(r.headers.get('location'), '/#/?linked=microsoft');
  u = await startAt('microsoft');
  nextClaims.nonce = u.searchParams.get('nonce');
  r = await callback('microsoft', u.searchParams.get('state'));
  assert.equal(r.status, 303);
  assert.ok(r.headers.get('set-cookie'));
  await ctx.acc('DELETE', '/identities/microsoft');
  const log = (await ctx.acc('GET', '/firm/events')).events.map((e) => e.type);
  assert.ok(log.includes('identity_linked') && log.includes('identity_unlinked') && log.includes('clients_imported'));
});
