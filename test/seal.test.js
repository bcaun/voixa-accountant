// Electronic seal (PAdES) on the PDF tracking report: local key and remote CSC signing,
// with a signature timestamp; checked with OpenSSL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, privateEncrypt, constants } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const pki = await mkdtemp(path.join(tmpdir(), 'pescada-seal-'));
const sh = (...args) => execFileSync('openssl', args, { cwd: pki, stdio: ['ignore', 'pipe', 'pipe'] });
await writeFile(path.join(pki, 'seal.ext'), 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n');
await writeFile(path.join(pki, 'tsa.ext'), 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test Root CA');
for (const [n, subj] of [['seal', '/CN=Voixa Consultors S.L./O=Voixa Consultors S.L./C=ES'], ['tsa', '/CN=Test TSA']]) {
  sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.csr`, '-subj', subj);
  sh('x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${n}.pem`, '-days', '2', '-extfile', `${n}.ext`);
}
await writeFile(path.join(pki, 'serial'), '01\n');
await writeFile(path.join(pki, 'tsa.cnf'), `[ tsa ]\ndefault_tsa = t\n[ t ]\ndir = ${pki}\nserial = $dir/serial\nsigner_cert = $dir/tsa.pem\ncerts = $dir/tsa.pem\nsigner_key = $dir/tsa.key\nsigner_digest = sha256\ndefault_policy = 1.2.3.4.1\ndigests = sha256\ness_cert_id_alg = sha256\n`);
const tsa = http.createServer((req, res) => {
  const chunks = []; req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    await writeFile(path.join(pki, 'q.tsq'), Buffer.concat(chunks));
    sh('ts', '-reply', '-config', 'tsa.cnf', '-queryfile', 'q.tsq', '-out', 'r.tsr');
    res.end(await readFile(path.join(pki, 'r.tsr')));
  });
}).listen(0);
// a stand-in remote signing service speaking the CSC API v2
let cscSigns = 0;
const cscSrv = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/oauth2/token') return res.end(JSON.stringify({ access_token: 'tk', expires_in: 3600 }));
    if (req.headers.authorization !== 'Bearer tk') { res.statusCode = 401; return res.end('{}'); }
    const b = JSON.parse(body || '{}');
    const pem = (f) => readFile(path.join(pki, f), 'utf8').then((s) => s.replace(/-----[^-]+-----|\s/g, ''));
    if (req.url === '/csc/v2/credentials/info') return res.end(JSON.stringify({ cert: { certificates: [await pem('seal.pem'), await pem('ca.pem')] }, key: { algo: ['1.2.840.113549.1.1.1'] } }));
    if (req.url === '/csc/v2/credentials/authorize') return res.end(JSON.stringify({ SAD: 'sad-1' }));
    if (req.url === '/csc/v2/signatures/signHash' && b.SAD === 'sad-1') {
      cscSigns++;
      // RSA PKCS#1 v1.5 over a SHA-256 DigestInfo, as an HSM does for signHash
      const digestInfo = Buffer.concat([Buffer.from('3031300d060960864801650304020105000420', 'hex'), Buffer.from(b.hashes[0], 'base64')]);
      const sig = privateEncrypt({ key: createPrivateKey(await readFile(path.join(pki, 'seal.key'))), padding: constants.RSA_PKCS1_PADDING }, digestInfo);
      return res.end(JSON.stringify({ signatures: [sig.toString('base64')] }));
    }
    res.statusCode = 400; res.end('{"error":"invalid_request"}');
  });
}).listen(0);
await Promise.all([tsa, cscSrv].map((s) => new Promise((r) => (s.listening ? r() : s.once('listening', r)))));

const dir = await mkdtemp(path.join(tmpdir(), 'pescada-sealdata-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/voixa_test',
  MAIL_TRANSPORT: 'memory', EMAIL_LANG: 'en', STORAGE_DRIVER: 'fs', STORAGE_DIR: dir, SCHEDULER: 'off', APP_URL: 'http://localhost',
  TSA_URL: `http://127.0.0.1:${tsa.address().port}/`, TSA_NAME: 'Test TSA',
  SEAL_NAME: 'Voixa Consultors S.L.', SEAL_CERT_FILE: path.join(pki, 'seal.pem'), SEAL_KEY_FILE: path.join(pki, 'seal.key'), SEAL_CHAIN_FILE: path.join(pki, 'ca.pem'),
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/server.js');
const { createLoginLink } = await import('../src/auth.js');
const { config } = await import('../src/config.js');

let server, base;
before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); tsa.close(); cscSrv.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); await rm(pki, { recursive: true, force: true }); });

const ctx = {};
async function getPdf(q = '') {
  const res = await fetch(`${base}/api/companies/${ctx.co}/report.pdf${q}`, { headers: { cookie: ctx.cookie, 'X-Voixa': '1' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  return Buffer.from(await res.arrayBuffer());
}
/** Split a sealed PDF into the signed bytes and the CMS, then ask OpenSSL to check the seal. */
async function opensslVerify(pdf) {
  const m = /\/ByteRange \[0 (\d+) (\d+) (\d+)\]/.exec(pdf.toString('latin1'));
  assert.ok(m, 'a ByteRange');
  const [a, b, c] = m.slice(1).map(Number);
  await writeFile(path.join(pki, 'data.bin'), Buffer.concat([pdf.subarray(0, a), pdf.subarray(b, b + c)]));
  const hex = pdf.subarray(a + 1, b - 1).toString('latin1').replace(/0+$/, '');
  await writeFile(path.join(pki, 'sig.der'), Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'));
  try {
    sh('cms', '-verify', '-binary', '-inform', 'DER', '-in', 'sig.der', '-content', 'data.bin', '-CAfile', 'ca.pem', '-purpose', 'any', '-out', '/dev/null');
    return true;
  } catch { return false; }
}

test('setup: a firm, a client and some history', async () => {
  const { rows: [f] } = await pool.query(`insert into firms (name, country) values ('Voixa', 'ES') returning id`);
  const { rows: [u] } = await pool.query(`insert into users (email, name, role, firm_id) values ('elena@voixa.es', 'Elena Ruiz', 'accountant', $1) returning id`, [f.id]);
  const token = new URL(await createLoginLink(u.id)).searchParams.get('token');
  const r = await fetch(`${base}/auth/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }) });
  ctx.cookie = r.headers.get('set-cookie').split(';')[0];
  const call = (m, p, body) => fetch(`${base}/api${p}`, { method: m, headers: { cookie: ctx.cookie, 'X-Voixa': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
  ctx.co = (await call('POST', '/companies', { name: 'Sol y Mar Hospitality SL', nif: 'B56781234' })).id;
  await call('POST', `/companies/${ctx.co}/requests`, { title: 'Extracto bancario — octubre → T3', due: '2026-12-10' });
});

test('the PDF report carries a PAdES seal with a signature timestamp, which OpenSSL accepts', async () => {
  const pdf = await getPdf();
  const s = pdf.toString('latin1');
  assert.match(s, /^%PDF-/);
  assert.match(s, /\/SubFilter \/ETSI\.CAdES\.detached/);
  assert.equal(await opensslVerify(pdf), true);
  const cms = await readFile(path.join(pki, 'sig.der'));
  assert.ok(cms.includes(Buffer.from('060b2a864886f70d010910020e', 'hex')), 'a signature timestamp (CAdES-T)');
  assert.ok(cms.includes(Buffer.from('060b2a864886f70d010910022f', 'hex')), 'the signing-certificate-v2 attribute');
  ctx.pdf = pdf;
});

test('downloading again reuses the sealed PDF until the log changes', async () => {
  assert.deepEqual(await getPdf(), ctx.pdf, 'the same sealed file, no new seal or timestamp');
  const call = (m, p, body) => fetch(`${base}/api${p}`, { method: m, headers: { cookie: ctx.cookie, 'X-Voixa': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await call('POST', `/companies/${ctx.co}/requests`, { title: 'Facturas, noviembre', due: '2026-12-20' });
  const fresh = await getPdf();
  assert.notDeepEqual(fresh, ctx.pdf, 'a new entry in the log makes a new sealed report');
  assert.equal(await opensslVerify(fresh), true);
});

test('any change to the sealed PDF breaks the seal', async () => {
  const bad = Buffer.from(ctx.pdf);
  const at = bad.indexOf('/Count 1');      // a byte inside the sealed range
  bad[at + 7] = '2'.charCodeAt(0);
  assert.equal(await opensslVerify(bad), false);
});

test('remote sealing through the CSC API gives the same result without the key on the server', async () => {
  Object.assign(config.seal, { certFile: '', keyFile: '', cscUrl: `http://127.0.0.1:${cscSrv.address().port}`, cscClientId: 'id', cscClientSecret: 'secret', cscCredentialId: 'voixa-seal' });
  await pool.query('delete from sealed_reports'); // otherwise the report sealed with the local key is reused
  const pdf = await getPdf();
  assert.equal(cscSigns, 1);
  assert.equal(await opensslVerify(pdf), true);
});

test('without a seal the PDF is still issued, unsealed; the full export includes it', async () => {
  Object.assign(config.seal, { cscUrl: '' });
  const pdf = await getPdf();
  assert.doesNotMatch(pdf.toString('latin1'), /ByteRange/);
  const zip = Buffer.from(await (await fetch(`${base}/api/companies/${ctx.co}/export-all`, { headers: { cookie: ctx.cookie, 'X-Voixa': '1' } })).arrayBuffer()).toString('latin1');
  assert.ok(zip.includes('tracking-report.pdf'));
});
