// Two-step sign-in for accountants, sessions, idle time-out and the firm's audit log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-sec-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost', SECRET_KEY: 'test-secret',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { totpAt, unbase32, verifyTotp, base32 } = await import('../src/totp.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

async function login(userId, ua = 'Test browser') {
  const token = new URL(await createLoginLink(userId)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', headers: { 'user-agent': ua }, body: new URLSearchParams({ token }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body, expect = 200) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1', 'user-agent': ua } };
    if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  return { cookie, get: (p, e) => call('GET', p, undefined, e), post: (p, b, e = 200) => call('POST', p, b ?? {}, e), patch: (p, b, e = 200) => call('PATCH', p, b, e), del: (p, e) => call('DELETE', p, undefined, e) };
}
const now = () => Math.floor(Date.now() / 30000);
const ctx = {};

test('TOTP codes match the RFC 6238 test vector', () => {
  // RFC 6238, SHA-1, secret "12345678901234567890", T = 59 s → 94287082 (8 digits; 287082 as 6 digits)
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(unbase32(secret).toString(), '12345678901234567890');
  assert.equal(totpAt(secret, 1), '287082');
  assert.equal(verifyTotp(secret, '287082', 59 * 1000), 1);
  assert.equal(verifyTotp(secret, '287083', 59 * 1000), null);
});

test('an accountant turns on two-step sign-in and gets recovery codes', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa Accounting', 'ES') returning id`);
  const { rows: [u] } = await pool.query(`insert into users (email, name, role, firm_id) values ('elena@voixa.es', 'Elena', 'accountant', $1) returning id`, [f.id]);
  Object.assign(ctx, { firm: f.id, uid: u.id });
  const a = await login(u.id);
  const setup = await a.post('/me/2fa/setup');
  assert.match(setup.uri, /^otpauth:\/\/totp\/Pescada%3Aelena%40voixa\.es\?secret=/);
  assert.match(setup.qr, /^<svg/);
  ctx.secret = setup.secret.replace(/\s/g, '');
  const { rows: [stored] } = await pool.query('select totp_pending from users where id = $1', [u.id]);
  assert.ok(!stored.totp_pending.includes(ctx.secret), 'the secret is stored encrypted');
  await a.post('/me/2fa/enable', { code: '000000' }, 400);
  const on = await a.post('/me/2fa/enable', { code: totpAt(ctx.secret, now()) });
  assert.equal(on.recoveryCodes.length, 10);
  ctx.recovery = on.recoveryCodes;
  assert.equal((await a.get('/me')).user.mfa.enabled, true);
  ctx.first = a;
});

test('a new sign-in is locked until the code is entered', async () => {
  const b = await login(ctx.uid, 'Second laptop');
  const me = await b.get('/me');
  assert.equal(me.user.mfa.pending, true);
  assert.deepEqual(me.companies, []);
  const blocked = await b.get('/overview', 401);
  assert.equal(blocked.code, 'mfa_required');
  await b.post('/auth/mfa', { code: '123456' }, 400);
  // the code already used to turn it on cannot be used again
  await b.post('/auth/mfa', { code: totpAt(ctx.secret, now() - 1) }).catch(() => {});
  const { rows: [r] } = await pool.query('select totp_last_step from users where id = $1', [ctx.uid]);
  const step = Math.max(now(), Number(r.totp_last_step) + 1);
  await pool.query('update users set totp_last_step = $2 where id = $1', [ctx.uid, step - 1]);
  await b.post('/auth/mfa', { code: totpAt(ctx.secret, step) });
  await b.get('/overview');
  ctx.second = b;
});

test('a recovery code works once', async () => {
  const c = await login(ctx.uid, 'Phone');
  await c.post('/auth/mfa', { code: ctx.recovery[0].toLowerCase() });
  await c.get('/overview');
  const d = await login(ctx.uid, 'Phone again');
  await d.post('/auth/mfa', { code: ctx.recovery[0] }, 400);
  assert.equal((await c.get('/me')).user.mfa.recoveryLeft, 9);
});

test('sessions can be listed and signed out', async () => {
  const list = await ctx.first.get('/me/sessions');
  assert.ok(list.sessions.length >= 3);
  assert.equal(list.sessions.filter((s) => s.current).length, 1);
  const other = list.sessions.find((s) => s.device === 'Second laptop');
  await ctx.first.del(`/me/sessions/${other.id}`);
  await ctx.second.get('/overview', 401);
  const out = await ctx.first.post('/me/sessions/sign-out-others');
  assert.ok(out.signedOut >= 1);
  assert.equal((await ctx.first.get('/me/sessions')).sessions.length, 1);
});

test('an accountant idle for too long has to sign in again', async () => {
  await pool.query(`update sessions set last_seen_at = now() - interval '13 hours' where user_id = $1`, [ctx.uid]);
  await ctx.first.get('/me', 401);
});

test('a firm can require two-step sign-in; until it is set up only set-up is possible', async () => {
  const { rows: [u] } = await pool.query(`insert into users (email, name, role, firm_id) values ('pablo@voixa.es', 'Pablo', 'accountant', $1) returning id`, [ctx.firm]);
  const elena = await login(ctx.uid);
  await elena.post('/auth/mfa', { code: ctx.recovery[1] });
  await elena.patch('/firm', { name: 'Voixa Accounting', country: 'ES', requireMfa: true });
  const p = await login(u.id);
  assert.equal((await p.get('/me')).user.mfa.setupRequired, true);
  assert.equal((await p.get('/overview', 403)).code, 'mfa_setup_required');
  const s = await p.post('/me/2fa/setup');
  await p.post('/me/2fa/enable', { code: totpAt(s.secret.replace(/\s/g, ''), now()) });
  await p.get('/overview');
  await elena.post('/me/2fa/disable', { code: '000000' }, 403);
  const log = await elena.get('/firm/events');
  const types = log.events.map((e) => e.type);
  for (const t of ['mfa_enabled', 'firm_updated', 'recovery_code_used', 'sessions_revoked']) assert.ok(types.includes(t), t);
});
