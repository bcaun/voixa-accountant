// Protection against fake sign-ups: email confirmation, robot checks, limits for trial firms.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-signup-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'auto', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  SIGNUP_DAILY_MAX: '8', TRIAL_MAX_CLIENTS: '2', TRIAL_MAX_INVITES: '3', SIGNUP_NOTIFY_EMAIL: 'owner@pescada.test',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { sentMail, flushEmails } = await import('../src/mailer.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

const signup = (body) => fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Voixa': '1' }, body: JSON.stringify(body) });
const firms = async () => (await pool.query('select count(*)::int as n from firms')).rows[0].n;
const person = { firmName: 'Studio Neri', country: 'IT', name: 'Sara Neri', email: 'sara@studioneri.it' };
async function open(email) {
  await flushEmails();
  const m = [...sentMail].reverse().find((x) => x.to_email === email);
  const token = new URL(/https?:\/\/\S+token=\S+/.exec(m.body_text)[0]).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], token };
}
const ctx = {};

test('robots get the same answer as people, and nothing happens', async () => {
  assert.equal((await signup({ ...person, ms: 5000, website: 'http://spam.example' })).status, 200);
  assert.equal((await signup({ ...person, ms: 400 })).status, 200, 'filled in too fast');
  assert.equal((await signup(person)).status, 200, 'no timing at all');
  await flushEmails();
  assert.equal(sentMail.length, 0);
  assert.equal((await pool.query('select count(*)::int as n from signup_requests')).rows[0].n, 0);
});

test('throwaway mailboxes are refused', async () => {
  const r = await signup({ ...person, email: 'x@mailinator.com', ms: 5000 });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /work email/);
  assert.equal((await signup({ ...person, email: 'x@eu.yopmail.com', ms: 5000 })).status, 400, 'subdomains too');
});

test('the firm is created only when the emailed link is opened, in the person’s language', async () => {
  assert.equal((await signup({ ...person, ms: 5000 })).status, 200);
  assert.equal(await firms(), 0, 'nothing yet');
  await flushEmails();
  const m = sentMail.find((x) => x.to_email === person.email);
  assert.equal(m.subject, 'Conferma la tua email per iniziare con Pescada');
  const r = await open(person.email);
  assert.equal(r.status, 303);
  assert.equal(await firms(), 1);
  ctx.cookie = r.cookie;
  const again = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token: r.token }) });
  assert.equal(again.status, 400, 'the link works once');
  await flushEmails();
  assert.ok(sentMail.some((x) => x.to_email === 'owner@pescada.test' && /New firm signed up: Studio Neri/.test(x.subject)), 'the owner is told');
});

const as = (method, p, body, expect = 200) => fetch(`${base}/api${p}`, {
  method, headers: { cookie: ctx.cookie, 'X-Voixa': '1', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
}).then(async (res) => { const d = await res.json().catch(() => ({})); assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(d)}`); return d; });

test('a trial firm has a limited number of clients and invitations a day', async () => {
  await as('POST', '/companies', { name: 'Uno Srl', contactEmail: 'a@uno.it' }, 201);
  await as('POST', '/companies', { name: 'Due Srl', contactEmail: 'b@due.it' }, 201);
  const third = await as('POST', '/companies', { name: 'Tre Srl' }, 403);
  assert.equal(third.code, 'trial_limit');
  const co = (await as('GET', '/me')).companies[0].id;
  await as('POST', `/companies/${co}/members`, { email: 'c@uno.it' }, 201);
  const fourth = await as('POST', `/companies/${co}/members`, { email: 'd@uno.it' }, 429);
  assert.equal(fourth.code, 'trial_limit');
  await as('POST', '/firm/team', { email: 'e@studioneri.it' }, 429);
  const { rows: [f] } = await pool.query(`update firms set plan = 'active' returning id`);
  await as('POST', `/companies/${co}/members`, { email: 'd@uno.it' }, 201);
  await as('POST', '/companies', { name: 'Tre Srl' }, 201);
  assert.ok(f.id);
});

test('a client’s address cannot open a firm; its owner is told why, in their language', async () => {
  sentMail.length = 0;
  assert.equal((await signup({ ...person, email: 'a@uno.it', ms: 5000 })).status, 200);
  await flushEmails();
  const [m] = sentMail.filter((x) => x.to_email === 'a@uno.it');
  assert.equal(m.subject, 'Questo indirizzo usa già Pescada');
  assert.match(m.body_text, /token=/, 'with a sign-in link to their client space');
  await pool.query(`delete from signup_requests where email = 'a@uno.it'`); // keep the limits below exact
});

test('a Pro firm’s logo appears in its clients’ emails and spaces; Essential firms are offered Pro', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
  const put = (body, type = 'image/png') => fetch(`${base}/api/firm/logo`, { method: 'PUT', headers: { cookie: ctx.cookie, 'X-Voixa': '1', 'Content-Type': type }, body });
  await pool.query(`update firms set tier = 'essential'`);
  let r = await put(png);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'pro');
  await pool.query(`update firms set tier = 'pro'`);
  assert.equal((await put(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).status, 400, 'no SVG');
  r = await put(png);
  assert.equal(r.status, 200);
  const { logoUrl } = await r.json();
  const img = await fetch(`${base}${logoUrl}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, png.length);
  sentMail.length = 0;
  const co = (await as('GET', '/me')).companies[0].id;
  await as('POST', `/companies/${co}/members`, { email: 'f@uno.it' }, 201);
  await flushEmails();
  assert.ok(sentMail.find((x) => x.to_email === 'f@uno.it').html.includes(logoUrl), 'the invitation shows the logo');
  assert.equal((await as('GET', `/companies/${co}`)).company.firm_logo, logoUrl);
  await as('DELETE', '/firm/logo');
  assert.equal((await fetch(`${base}${logoUrl}`)).status, 404);
});

test('the same address cannot be flooded, and there is a daily ceiling for everyone', async () => {
  sentMail.length = 0;
  for (let i = 0; i < 4; i++) assert.equal((await signup({ ...person, email: 'luca@rossi.it', ms: 5000 })).status, 200);
  await flushEmails();
  assert.equal(sentMail.filter((m) => m.to_email === 'luca@rossi.it').length, 3, 'at most three links a day to one address');
  await pool.query(`insert into signup_requests (token_hash, firm_name, country, email, ip, expires_at)
    select md5(g::text), 'Bot', 'IT', g || '@bot.example', '10.0.0.' || g, now() + interval '1 day' from generate_series(1, 4) g`);
  const r = await signup({ ...person, email: 'late@studio.it', ms: 5000 });
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /busy/);
});

test('turning sign-up off closes the form', async () => {
  const { config } = await import('../src/config.js');
  config.signup.enabled = false;
  assert.equal((await signup({ ...person, email: 'new@studio.it', ms: 5000 })).status, 403);
  config.signup.enabled = true;
});
