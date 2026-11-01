// Emails and the sign-in page speak the recipient's language.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-i18n-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'auto', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
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
  return async (method, p, body, expect = 200) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body instanceof FormData) opt.body = body; else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
const mailTo = (email) => sentMail.filter((m) => m.to_email === email);
const ctx = {};

test('an Italian firm’s client is invited in Italian', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Studio Rossi', 'IT') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id, notify_mode) values ('giulia@rossi.it', 'Giulia', 'accountant', $1, 'instant')`, [f.id]);
  ctx.acc = await as('giulia@rossi.it');
  await flushEmails(); sentMail.length = 0;
  ctx.co = (await ctx.acc('POST', '/companies', { name: 'Bottega Verdi Srl', contactEmail: 'marco@verdi.it' }, 201)).id;
  await flushEmails();
  const [invite] = mailTo('marco@verdi.it');
  assert.equal(invite.subject, 'Giulia ti ha invitato a Bottega Verdi Srl');
  assert.match(invite.body_text, /Ora hai accesso allo spazio di Bottega Verdi Srl/);
  assert.match(invite.html, /Accedi/);
  assert.equal((await ctx.acc('GET', '/me')).user.lang, 'it', 'the effective language is reported');
});

test('notifications to the accountant follow the firm’s country; a chosen language wins', async () => {
  ctx.cl = await as('marco@verdi.it');
  sentMail.length = 0;
  const f = new FormData(); f.append('category', 'Other'); f.append('files', new Blob(['%PDF fattura']), 'fattura.pdf');
  await ctx.cl('POST', `/companies/${ctx.co}/documents`, f, 201);
  await flushEmails();
  assert.match(mailTo('giulia@rossi.it')[0].subject, /^Nuovo documento da Bottega Verdi Srl: /);

  await ctx.acc('PATCH', '/me', { lang: 'de' });
  const me = await ctx.acc('GET', '/me');
  assert.deepEqual([me.user.lang, me.user.langChosen], ['de', 'de']);
  sentMail.length = 0;
  const g = new FormData(); g.append('category', 'Other'); g.append('files', new Blob(['%PDF rechnung']), 'rechnung.pdf');
  await ctx.cl('POST', `/companies/${ctx.co}/documents`, g, 201);
  await flushEmails();
  assert.match(mailTo('giulia@rossi.it')[0].subject, /^Neues Dokument von Bottega Verdi Srl: /);
  await ctx.acc('PATCH', '/me', { lang: 'xx' }, 400);
  await ctx.acc('PATCH', '/me', { lang: null });
  assert.equal((await ctx.acc('GET', '/me')).user.lang, 'it', 'back to automatic');
});

test('the sign-in page follows the browser language', async () => {
  const page = async (lang) => (await fetch(`${base}/auth/verify?token=x`, { headers: lang ? { 'Accept-Language': lang } : {} })).text();
  assert.match(await page('pt-PT,pt;q=0.9,en;q=0.5'), /<html lang="pt">[\s\S]*Entrar no Pescada/);
  assert.match(await page('de-DE'), /Bei Pescada anmelden/);
  assert.match(await page('ru'), /<html lang="en">[\s\S]*Sign in to Pescada/);
  const expired = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'Accept-Language': 'fr' }, body: new URLSearchParams({ token: 'nope' }) });
  assert.equal(expired.status, 400);
  assert.match(await expired.text(), /Ce lien ne fonctionne plus/);
});
