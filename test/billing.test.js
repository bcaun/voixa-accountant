// Self sign-up, trial, Stripe Checkout and webhooks (against a stand-in Stripe API).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const calls = [];
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body: new URLSearchParams(body), auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }));
    if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ url: 'https://billing.stripe.test/p_1' }));
    res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'nope' } }));
  });
}).listen(0);
await new Promise((r) => fake.once('listening', r));

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-bill-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_PRICE_ID: 'price_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${fake.address().port}`,
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
after(async () => { server.close(); fake.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); });

const post = (p, body) => fetch(`${base}/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Voixa': '1' }, body: JSON.stringify(body) });
async function signInFromMail(email) {
  await flushEmails();
  const m = [...sentMail].reverse().find((x) => x.to_email === email);
  const token = new URL(/https?:\/\/\S+token=\S+/.exec(m.body_text)[0]).searchParams.get('token');
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
const stripeEvent = (ev, secret = 'whsec_test') => {
  const payload = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: payload });
};
const ctx = {};

test('a firm signs itself up and gets a trial; the form does not reveal existing addresses', async () => {
  assert.equal((await post('/signup', { firmName: 'Studio Bianchi', country: 'IT', name: 'Luca Bianchi', email: 'luca@studiobianchi.it' })).status, 200);
  ctx.acc = await signInFromMail('luca@studiobianchi.it');
  const me = await ctx.acc('GET', '/me');
  assert.equal(me.user.firmRole, 'admin');
  assert.deepEqual([me.firmInfo.name, me.firmInfo.country, me.firmInfo.plan, me.firmInfo.trialDaysLeft], ['Studio Bianchi', 'IT', 'trial', 30]);
  assert.equal((await post('/signup', { firmName: 'X', country: 'IT', email: 'luca@studiobianchi.it' })).status, 200, 'same answer for a known address');
  assert.equal((await post('/signup', { firmName: 'X', country: 'XX', email: 'new@x.it' })).status, 400);
  ctx.co = (await ctx.acc('POST', '/companies', { name: 'Trattoria Uno', contactEmail: 'uno@example.it' }, 201)).id;
  const { rows: [f] } = await pool.query(`select id from firms where name = 'Studio Bianchi'`);
  ctx.firm = f.id;
});

test('when the trial ends the firm can read and subscribe but not change anything; its clients are not blocked', async () => {
  await pool.query(`update firms set trial_ends_at = now() - interval '1 day' where id = $1`, [ctx.firm]);
  const blocked = await ctx.acc('POST', '/companies', { name: 'Pizzeria Due' }, 402);
  assert.equal(blocked.code, 'subscription');
  await ctx.acc('GET', `/companies/${ctx.co}`);
  assert.equal((await ctx.acc('GET', '/me')).firmInfo.active, false);
  const uno = await signInFromMail('uno@example.it');
  const f = new FormData(); f.append('category', 'Other'); f.append('files', new Blob(['%PDF x']), 'x.pdf');
  await uno('POST', `/companies/${ctx.co}/documents`, f, 201);
  const b = await ctx.acc('GET', '/billing');
  assert.deepEqual([b.plan, b.trialDaysLeft, b.onlinePayment], ['trial', 0, true]);
});

test('Stripe Checkout is opened with the price and one unit per open client', async () => {
  const r = await ctx.acc('POST', '/billing/checkout');
  assert.equal(r.url, 'https://checkout.stripe.test/cs_1');
  const call = calls.find((c) => c.url === '/v1/checkout/sessions');
  assert.equal(call.auth, 'Bearer sk_test_123');
  assert.equal(call.body.get('line_items[0][price]'), 'price_123');
  assert.equal(call.body.get('line_items[0][quantity]'), '1');
  assert.equal(call.body.get('client_reference_id'), ctx.firm);
  assert.equal(call.body.get('mode'), 'subscription');
});

test('signed Stripe events switch the firm on and off; unsigned ones are refused', async () => {
  const ev = { type: 'checkout.session.completed', data: { object: { client_reference_id: ctx.firm, customer: 'cus_1', subscription: 'sub_1' } } };
  assert.equal((await stripeEvent(ev, 'whsec_wrong')).status, 400);
  assert.equal((await stripeEvent(ev)).status, 200);
  await ctx.acc('POST', '/companies', { name: 'Pizzeria Due' }, 201);
  assert.equal((await ctx.acc('POST', '/billing/portal')).url, 'https://billing.stripe.test/p_1');
  await stripeEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
  await ctx.acc('POST', '/companies', { name: 'Bar Tre' }, 402);
  const log = (await ctx.acc('GET', '/firm/events')).events.map((e) => e.type);
  assert.ok(log.includes('signed_up') && log.includes('subscribed') && log.includes('subscription_canceled'));
});
