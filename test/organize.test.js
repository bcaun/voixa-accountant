// Tags on clients and the deadlines calendar (in the app and as an iCal feed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-org-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');

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
    if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
const ctx = {};

test('clients carry tags the firm sees and the client does not', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id) values ('elena@voixa.es', 'Elena', 'accountant', $1)`, [f.id]);
  ctx.acc = await as('elena@voixa.es');
  ctx.a = (await ctx.acc('POST', '/companies', { name: 'Sol y Mar SL', contactEmail: 'daniel@solymar.es', tags: 'Restaurants, monthly VAT, restaurants' }, 201)).id;
  ctx.b = (await ctx.acc('POST', '/companies', { name: 'Taller Ruiz SL', tags: ['quarterly'] }, 201)).id;
  const me = await ctx.acc('GET', '/me');
  assert.deepEqual(me.companies.find((c) => c.id === ctx.a).tags, ['Restaurants', 'monthly VAT'], 'trimmed, without duplicates');
  assert.deepEqual((await ctx.acc('GET', '/overview')).companies.find((c) => c.id === ctx.b).tags, ['quarterly']);
  await ctx.acc('PATCH', `/companies/${ctx.b}`, { tags: 'quarterly, difficult' });
  const ws = await ctx.acc('GET', `/companies/${ctx.b}`);
  assert.deepEqual(ws.company.tags, ['quarterly', 'difficult']);
  assert.ok(!ws.events.some((e) => /difficult/.test(e.text)), 'tags stay out of the shared log');
  ctx.cl = await as('daniel@solymar.es');
  assert.equal((await ctx.cl('GET', `/companies/${ctx.a}`)).company.tags, undefined, 'the client never sees them');
  assert.equal((await ctx.cl('GET', '/me')).companies[0].tags, undefined);
  await ctx.cl('PATCH', `/companies/${ctx.a}`, { tags: 'x' }, 403);
});

test('an import can tag clients from a column', async () => {
  const plan = await ctx.acc('POST', '/companies/import', { csv: 'Name;Etiquetas\r\nBar Uno SL;restaurants | monthly VAT\r\n', commit: true });
  const id = plan.rows[0].id;
  assert.deepEqual((await ctx.acc('GET', `/companies/${id}`)).company.tags, ['restaurants', 'monthly VAT']);
});

test('the calendar lists open requests and reports still owed, overdue first', async () => {
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await ctx.acc('POST', `/companies/${ctx.a}/requests`, { title: 'Bank statement, October', due: day(5) }, 201);
  await ctx.acc('POST', `/companies/${ctx.b}/requests`, { title: 'Invoices, September', due: day(10) }, 201);
  await pool.query(`update items set due_at = now() - interval '3 days' where title = 'Invoices, September'`);
  const ev = (await ctx.acc('GET', '/calendar')).events;
  assert.deepEqual(ev.map((e) => [e.title, e.overdue]), [['Invoices, September', true], ['Bank statement, October', false]]);
  assert.deepEqual(ev[1].tags, ['Restaurants', 'monthly VAT']);
  const mine = (await ctx.cl('GET', '/calendar')).events;
  assert.deepEqual(mine.map((e) => e.title), ['Bank statement, October'], 'a client sees only its own');
});

test('the private iCal feed works in calendar apps, and a new link retires the old one', async () => {
  const { url } = await ctx.acc('GET', '/calendar/link');
  assert.equal((await ctx.acc('GET', '/calendar/link')).url, url, 'the same link until it is reset');
  const path1 = new URL(url).pathname;
  const res = await fetch(`${base}${path1}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(ics, /SUMMARY:Sol y Mar SL: Bank statement\\, October/);
  assert.match(ics, /DTSTART;VALUE=DATE:\d{8}/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'long lines are folded');
  const { url: url2 } = await ctx.acc('POST', '/calendar/link');
  assert.notEqual(url2, url);
  assert.equal((await fetch(`${base}${path1}`)).status, 404);
  assert.equal((await fetch(`${base}/calendar/not-a-token.ics`)).status, 404);
});
