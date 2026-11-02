// Trusted timestamps on the evidence log, against a real RFC 3161 TSA run with OpenSSL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tsaDir = await mkdtemp(path.join(tmpdir(), 'pescada-tsa-'));
const sh = (...args) => execFileSync('openssl', args, { cwd: tsaDir, stdio: ['ignore', 'pipe', 'pipe'] });
// a test CA and a timestamping certificate it issues
await writeFile(path.join(tsaDir, 'ext.cnf'), 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test Root CA');
sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tsa.key', '-out', 'tsa.csr', '-subj', '/CN=Test TSA/O=Pescada tests');
sh('x509', '-req', '-in', 'tsa.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'tsa.pem', '-days', '2', '-extfile', 'ext.cnf');
await writeFile(path.join(tsaDir, 'tsa.cnf'), `[ tsa ]
default_tsa = tsa_config
[ tsa_config ]
dir = ${tsaDir}
serial = $dir/serial
signer_cert = $dir/tsa.pem
certs = $dir/tsa.pem
signer_key = $dir/tsa.key
signer_digest = sha256
default_policy = 1.2.3.4.1
digests = sha256
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_chain = no
ess_cert_id_alg = sha256
`);
await writeFile(path.join(tsaDir, 'serial'), '01\n');
let tsaCalls = 0;
const tsa = http.createServer((req, res) => {
  const chunks = []; req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    tsaCalls++;
    await writeFile(path.join(tsaDir, 'q.tsq'), Buffer.concat(chunks));
    try { sh('ts', '-reply', '-config', 'tsa.cnf', '-queryfile', 'q.tsq', '-out', 'r.tsr'); } catch (err) { res.statusCode = 500; return res.end(String(err.stderr)); }
    res.setHeader('Content-Type', 'application/timestamp-reply');
    res.end(await readFile(path.join(tsaDir, 'r.tsr')));
  });
}).listen(0);
await new Promise((r) => tsa.once('listening', r));

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-ts-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  TSA_URL: `http://127.0.0.1:${tsa.address().port}/tsr`, TSA_NAME: 'Test TSA', TSA_QUALIFIED: 'yes',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const ts = await import('../src/timestamps.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); tsa.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); await rm(tsaDir, { recursive: true, force: true }); });

async function as(email) {
  const { rows: [u] } = await pool.query('select id from users where email = $1', [email]);
  const token = new URL(await createLoginLink(u.id)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, p, body, expect = 200, raw = false) => {
    const opt = { method, headers: { cookie, 'X-Voixa': '1' } };
    if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`${base}/api${p}`, opt);
    if (raw) return Buffer.from(await res.arrayBuffer());
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    assert.equal(res.status, expect, `${method} ${p} → ${res.status}`);
    return data;
  };
}
const ctx = {};

test('the logs that grew are sealed by one timestamp; nothing new means no call to the TSA', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  await pool.query(`insert into users (email, name, role, firm_id) values ('elena@voixa.es', 'Elena', 'accountant', $1)`, [f.id]);
  ctx.acc = await as('elena@voixa.es');
  ctx.a = (await ctx.acc('POST', '/companies', { name: 'Sol y Mar SL' }, 201)).id;
  ctx.b = (await ctx.acc('POST', '/companies', { name: 'Taller Ruiz SL' }, 201)).id;
  const t1 = await ts.anchorNow();
  assert.ok(t1);
  assert.equal(t1.manifest.trim().split('\n').length, 2);
  assert.equal(t1.signer, 'CN=Test TSA, O=Pescada tests');
  assert.equal(await ts.anchorNow(), null);
  assert.equal(tsaCalls, 1);
  await ctx.acc('POST', `/companies/${ctx.a}/requests`, { title: 'Bank statement', due: '2026-12-10' }, 201);
  const t2 = await ts.anchorNow();
  assert.deepEqual(t2.manifest.trim().split('\n').map((l) => l.split(' ')[0]), [ctx.a], 'only the client whose log grew');
  ctx.t2 = t2;
});

test('OpenSSL confirms the stored token against the manifest and the test CA', async () => {
  await writeFile(path.join(tsaDir, 'm.txt'), ctx.t2.manifest);
  await writeFile(path.join(tsaDir, 't.tst'), ctx.t2.token);
  const out = sh('ts', '-verify', '-token_in', '-in', 't.tst', '-data', 'm.txt', '-CAfile', 'ca.pem', '-untrusted', 'tsa.pem').toString();
  assert.match(out, /Verification: OK/);
});

test('the app, the printable report and the full export show and carry the timestamp', async () => {
  const v = await ctx.acc('GET', `/companies/${ctx.a}/verify`);
  assert.equal(v.ok, true);
  assert.equal(v.timestamp.qualified, true);
  assert.equal(v.timestamp.tsa, 'Test TSA');
  const report = await ctx.acc('GET', `/companies/${ctx.a}/report`);
  assert.match(report, /Qualified timestamp/);
  const zip = (await ctx.acc('GET', `/companies/${ctx.a}/export-all`, undefined, 200, true)).toString('latin1');
  for (const n of ['timestamps/README.txt', 'manifest.txt', '.tst']) assert.ok(zip.includes(n), n);
});

test('re-checking finds any change made to the log after it was sealed', async () => {
  assert.deepEqual((await ts.verifyAll()).problems, []);
  const c = await pool.connect();
  try {
    await c.query(`set session_replication_role = replica`); // bypass the append-only trigger, as an attacker with database access would
    const sealed = Number(ctx.t2.manifest.trim().split(' ')[1]); // the entry the timestamp covers
    await c.query(`update events set hash = repeat('0', 64) where company_id = $1 and seq = $2`, [ctx.a, sealed]);
  } finally { await c.query(`set session_replication_role = origin`); c.release(); }
  const r = await ts.verifyAll();
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /has changed since it was timestamped/);
});

test('a token whose content was altered fails the signature check', () => {
  const bad = Buffer.from(ctx.t2.token);
  const i = bad.indexOf(Buffer.from(ctx.t2.digest, 'hex'));
  bad[i] ^= 0xff; // the digest inside the signed TSTInfo
  assert.equal(ts.readToken(bad, { response: false }).signatureOk, false);
  assert.equal(ts.readToken(ctx.t2.token, { response: false }).signatureOk, true);
});
