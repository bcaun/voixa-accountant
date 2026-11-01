// The firm's team: administrators and staff, access to all or assigned clients, disabling people.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-team-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
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
const ctx = {};

test('the first accountant is an administrator and invites a colleague for some clients only', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id, notify_mode) values ('elena@voixa.es', 'Elena', 'accountant', $1, 'instant')`, [f.id]);
  ctx.admin = await as('elena@voixa.es');
  assert.equal((await ctx.admin('GET', '/me')).user.firmRole, 'admin');
  ctx.a = (await ctx.admin('POST', '/companies', { name: 'Alfa SL', contactEmail: 'ana@alfa.es' }, 201)).id;
  ctx.b = (await ctx.admin('POST', '/companies', { name: 'Beta SL', contactEmail: 'bea@beta.es' }, 201)).id;
  await flushEmails(); sentMail.length = 0;
  await ctx.admin('POST', '/firm/team', { email: 'pablo@voixa.es', name: 'Pablo', role: 'staff', allClients: false, companyIds: [ctx.a] }, 201);
  await flushEmails();
  assert.match(sentMail.find((m) => m.to_email === 'pablo@voixa.es').body_text, /added to the Voixa team/);
  await ctx.admin('POST', '/firm/team', { email: 'ana@alfa.es', name: 'Ana' }, 409); // a client's address
  await ctx.admin('POST', '/firm/team', { email: 'pablo@voixa.es' }, 409); // already on the team
  ctx.staff = await as('pablo@voixa.es');
  await pool.query(`update users set notify_mode = 'instant' where email = 'pablo@voixa.es'`);
});

test('staff see and hear about only their assigned clients', async () => {
  assert.deepEqual((await ctx.staff('GET', '/me')).companies.map((c) => c.id), [ctx.a]);
  assert.deepEqual((await ctx.staff('GET', '/overview')).companies.map((c) => c.id), [ctx.a]);
  await ctx.staff('GET', `/companies/${ctx.b}`, undefined, 404);
  await ctx.staff('GET', `/companies/${ctx.a}`);
  const bea = await as('bea@beta.es');
  const f = new FormData(); f.append('category', 'Other'); f.append('files', new Blob(['%PDF beta']), 'beta.pdf');
  sentMail.length = 0;
  await bea('POST', `/companies/${ctx.b}/documents`, f, 201);
  await flushEmails();
  const to = sentMail.map((m) => m.to_email);
  assert.ok(to.includes('elena@voixa.es'));
  assert.ok(!to.includes('pablo@voixa.es'), 'not told about a client he cannot see');
  // a client they create is theirs
  const c = await ctx.staff('POST', '/companies', { name: 'Gamma SL' }, 201);
  assert.deepEqual((await ctx.staff('GET', '/me')).companies.map((x) => x.id).sort(), [ctx.a, c.id].sort());
});

test('only administrators manage the firm, its team and AI costs', async () => {
  await ctx.staff('PATCH', '/firm', { name: 'Hijack', country: 'ES' }, 403);
  await ctx.staff('POST', '/firm/team', { email: 'x@voixa.es' }, 403);
  await ctx.staff('GET', '/ai-usage', undefined, 403);
  await ctx.staff('GET', '/firm/events', undefined, 403);
  const team = await ctx.staff('GET', '/firm/team');
  assert.equal(team.admin, false);
  assert.equal(team.team.length, 2);
});

test('an administrator changes access and disables a colleague, who is signed out at once', async () => {
  const pablo = (await ctx.admin('GET', '/firm/team')).team.find((m) => m.email === 'pablo@voixa.es');
  await ctx.admin('PATCH', `/firm/team/${pablo.id}`, { allClients: true });
  assert.equal((await ctx.staff('GET', '/me')).companies.length, 3);
  await ctx.admin('PATCH', `/firm/team/${pablo.id}`, { disabled: true });
  await ctx.staff('GET', '/me', undefined, 401);
  const elena = (await ctx.admin('GET', '/firm/team')).team.find((m) => m.email === 'elena@voixa.es');
  await ctx.admin('PATCH', `/firm/team/${elena.id}`, { role: 'staff' }, 409); // the last administrator
  const log = (await ctx.admin('GET', '/firm/events')).events.map((e) => e.text).join('\n');
  assert.match(log, /invited Pablo/);
  assert.match(log, /account disabled/);
  // invited again later, the same account comes back
  await ctx.admin('POST', '/firm/team', { email: 'pablo@voixa.es', role: 'staff' }, 201);
  assert.equal((await ctx.admin('GET', '/firm/team')).team.find((m) => m.email === 'pablo@voixa.es').disabled_at, null);
});
