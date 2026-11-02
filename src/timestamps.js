// Trusted timestamps (RFC 3161) on the evidence log.
//
// Every hour (when something happened) Pescada writes a manifest with one line per client whose log
// grew: "<company id> <entry number> <hash of that entry>". Each entry hash covers the whole log
// before it, file fingerprints included. The SHA-256 of the manifest is sent to a timestamping
// authority (TSA); its signed token proves that every listed log existed, unchanged, at that time.
// With a qualified TSA (eIDAS art. 41) the law presumes the date and the integrity.
//
// The manifest and the token are kept, so anyone can check them later without Pescada:
//   openssl ts -verify -token_in -in token.tst -data manifest.txt -CAfile tsa-ca.pem
import { createHash, randomBytes, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { config } from './config.js';
import { pool, query } from './db.js';

/* ---------- a little DER (just what RFC 3161 needs) ---------- */

export const len = (n) => (n < 128 ? Buffer.from([n]) : (() => { const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); })());
export const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
export const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
export const int = (buf) => { let b = Buffer.from(buf); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); };
export const oid = (s) => {
  const p = s.split('.').map(Number), out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) { const b = [n & 0x7f]; let v = n >> 7; while (v) { b.unshift(0x80 | (v & 0x7f)); v >>= 7; } out.push(...b); }
  return tlv(0x06, Buffer.from(out));
};
const SHA256 = '2.16.840.1.101.3.4.2.1';

/** Parse one DER element: { tag, start, header, end, body, children? } with offsets into buf. */
export function parse(buf, start = 0) {
  const tag = buf[start];
  let p = start + 1, n = buf[p++];
  if (n & 0x80) { const k = n & 0x7f; n = 0; for (let i = 0; i < k; i++) n = n * 256 + buf[p++]; }
  const el = { tag, start, header: p - start, end: p + n, body: buf.subarray(p, p + n) };
  if (tag & 0x20) { el.children = []; for (let q = p; q < p + n;) { const c = parse(buf, q); el.children.push(c); q = c.end; } }
  return el;
}
export const oidStr = (body) => {
  const out = [Math.floor(body[0] / 40), body[0] % 40]; let v = 0;
  for (const b of body.subarray(1)) { v = v * 128 + (b & 0x7f); if (!(b & 0x80)) { out.push(v); v = 0; } }
  return out.join('.');
};
const intHex = (body) => Buffer.from(body).toString('hex').replace(/^00(?=.)/, '');
const genTime = (body) => {
  const s = body.toString('latin1'); // YYYYMMDDHHMMSS[.fff]Z
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}${s.slice(14).replace('Z', '') || ''}Z`);
};

/** A TimeStampReq for a SHA-256 digest, asking for the TSA certificate to be included. */
export function buildRequest(digestHex, nonceBuf, policy) {
  return seq(
    int(Buffer.from([1])),
    seq(seq(oid(SHA256), Buffer.from([0x05, 0x00])), tlv(0x04, Buffer.from(digestHex, 'hex'))),
    ...(policy ? [oid(policy)] : []),
    int(nonceBuf),
    tlv(0x01, Buffer.from([0xff])),
  );
}

/**
 * Read a TimeStampResp (or a bare token) and check what can be checked here: the digest and nonce
 * it answers, and the TSA's signature over it with the certificate it carries. Whether that
 * certificate is on the EU trusted list is a matter for the TSA chosen (see DEPLOY.md).
 */
export function readToken(buf, { response = true } = {}) {
  let tokenEl;
  if (response) {
    const resp = parse(buf);
    const status = Number(intHex(resp.children[0].children[0].body) || 0);
    if (status > 1 || !resp.children[1]) throw new Error(`the timestamping authority refused the request (status ${status})`);
    tokenEl = resp.children[1];
  } else tokenEl = parse(buf);
  const token = buf.subarray(tokenEl.start, tokenEl.end);
  const signedData = tokenEl.children[1].children[0];
  const parts = signedData.children;
  const encap = parts[2];
  const tstDer = encap.children[1].children[0].body; // [0] EXPLICIT OCTET STRING
  const tst = parse(Buffer.from(tstDer));
  const f = tst.children;
  const imprint = f[2].children[1].body.toString('hex');
  let nonce = null;
  for (const c of f.slice(5)) if (c.tag === 0x02) nonce = intHex(c.body);
  const info = { policy: oidStr(f[1].body), imprint, serial: intHex(f[3].body), genTime: genTime(f[4].body), nonce };

  // certificates [0] IMPLICIT, then signerInfos SET
  const certsEl = parts.find((c) => c.tag === 0xa0);
  const certs = certsEl ? certsEl.children.map((c) => { try { return new X509Certificate(buf.subarray(c.start, c.end)); } catch { return null; } }).filter(Boolean) : [];
  const signer = parts[parts.length - 1].children[0];
  let signatureOk = false, signerName = null;
  try {
    const sa = signer.children.find((c) => c.tag === 0xa0); // signedAttrs [0] IMPLICIT
    const digestAlg = oidStr(signer.children[2].children[0].body);
    const sigEl = [...signer.children].reverse().find((c) => c.tag === 0x04); // the signature value
    // the signature covers the signed attributes encoded as a SET (tag 0x31), not as [0]
    const attrs = Buffer.from(buf.subarray(sa.start, sa.end)); attrs[0] = 0x31;
    // and the messageDigest attribute must be the hash of the TSTInfo
    const md = sa.children.find((a) => oidStr(a.children[0].body) === '1.2.840.113549.1.9.4');
    const hashName = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1' }[digestAlg] || 'sha256';
    const mdOk = md && Buffer.compare(md.children[1].children[0].body, createHash(hashName).update(tstDer).digest()) === 0;
    for (const cert of certs) {
      if (mdOk && cryptoVerify(hashName, attrs, cert.publicKey, sigEl.body)) { signatureOk = true; signerName = cert.subject.replace(/\n/g, ', '); break; }
    }
  } catch { signatureOk = false; }
  return { token: Buffer.from(token), ...info, signatureOk, signerName };
}

/** Ask the configured TSA to timestamp a digest. */
export async function requestTimestamp(digestHex) {
  const nonce = randomBytes(8); nonce[0] &= 0x7f;
  const headers = { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' };
  if (config.tsa.user) headers.Authorization = `Basic ${Buffer.from(`${config.tsa.user}:${config.tsa.password}`).toString('base64')}`;
  const res = await fetch(config.tsa.url, { method: 'POST', headers, body: buildRequest(digestHex, nonce, config.tsa.policy || null), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`the timestamping authority answered ${res.status}`);
  const r = readToken(Buffer.from(await res.arrayBuffer()));
  if (r.imprint !== digestHex) throw new Error('the timestamp is for a different digest');
  if (r.nonce && r.nonce !== intHex(nonce)) throw new Error('the timestamp answers a different request');
  if (!r.signatureOk) throw new Error('the timestamp signature does not check out');
  return r;
}

export const timestampsOn = () => !!config.tsa.url;

/** Seal every log that grew since its last timestamp. Returns the new timestamp, or null if nothing changed. */
export async function anchorNow() {
  if (!timestampsOn()) return null;
  const { rows } = await query(
    `select c.id, c.head_seq, c.head_hash from companies c
     where c.head_seq > coalesce((select max(e.seq) from timestamp_entries e where e.company_id = c.id), 0)
     order by c.id`);
  if (!rows.length) return null;
  const manifest = rows.map((r) => `${r.id} ${r.head_seq} ${r.head_hash}\n`).join('');
  const digest = createHash('sha256').update(manifest).digest('hex');
  const t = await requestTimestamp(digest);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: [ts] } = await client.query(
      `insert into timestamps (tsa_url, tsa_name, qualified, digest, manifest, token, gen_time, serial, policy, signer)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [config.tsa.url, config.tsa.name, config.tsa.qualified, digest, manifest, t.token, t.genTime, t.serial, t.policy, t.signerName]);
    for (const r of rows) await client.query('insert into timestamp_entries (timestamp_id, company_id, seq, hash) values ($1,$2,$3,$4)', [ts.id, r.id, r.head_seq, r.head_hash]);
    await client.query('commit');
    return ts;
  } catch (err) { await client.query('rollback'); throw err; } finally { client.release(); }
}

/** The latest timestamp of a client's log: up to which entry, when, and by whom. */
export async function latestFor(companyId) {
  const { rows: [r] } = await query(
    `select e.seq, t.id, t.gen_time, t.tsa_name, t.qualified, t.serial from timestamp_entries e join timestamps t on t.id = e.timestamp_id
     where e.company_id = $1 order by e.seq desc limit 1`, [companyId]);
  return r || null;
}

/** All timestamps covering a client, with what is needed to check them outside Pescada. */
export async function allFor(companyId) {
  const { rows } = await query(
    `select t.*, e.seq, e.hash from timestamp_entries e join timestamps t on t.id = e.timestamp_id where e.company_id = $1 order by e.seq`, [companyId]);
  return rows;
}

/** Re-check every stored timestamp: manifest → digest → token → signature, and every line → the log. */
export async function verifyAll() {
  const { rows } = await query('select * from timestamps order by id');
  const problems = [];
  for (const t of rows) {
    const digest = createHash('sha256').update(t.manifest).digest('hex');
    let r;
    try { r = readToken(t.token, { response: false }); } catch (err) { problems.push(`#${t.id}: token unreadable (${err.message})`); continue; }
    if (digest !== t.digest || r.imprint !== digest) problems.push(`#${t.id}: the manifest does not match the timestamp`);
    if (!r.signatureOk) problems.push(`#${t.id}: the TSA signature does not check out`);
    for (const line of t.manifest.trim().split('\n')) {
      const [cid, s, hash] = line.split(' ');
      const { rows: [e] } = await query('select hash from events where company_id = $1 and seq = $2', [cid, Number(s)]);
      if (e && e.hash !== hash) problems.push(`#${t.id}: client ${cid} entry ${s} has changed since it was timestamped`);
    }
  }
  return { count: rows.length, problems };
}

/** Files to check a client's timestamps without Pescada: manifests, tokens, the TSA certificate and how-to. */
export async function proofEntries(companyId, dir = 'timestamps/') {
  const rows = await allFor(companyId);
  if (!rows.length) return [];
  const entries = [];
  for (const t of rows) {
    const n = String(t.id).padStart(6, '0');
    entries.push({ name: `${dir}${n}-manifest.txt`, data: Buffer.from(t.manifest) });
    entries.push({ name: `${dir}${n}.tst`, data: Buffer.from(t.token) });
  }
  const last = rows[rows.length - 1];
  entries.push({ name: `${dir}README.txt`, data: Buffer.from(`Trusted timestamps of this client's activity log (RFC 3161${last.qualified ? ', qualified under eIDAS art. 41' : ''})

Each NNNNNN-manifest.txt lists, for the clients whose log grew, "<client id> <entry number> <entry hash>".
Each entry hash covers the whole log up to that entry, file fingerprints included (see activity-log.csv).
NNNNNN.tst is the timestamp token for the SHA-256 of that manifest, signed by ${last.tsa_name || last.tsa_url}.

To check one with OpenSSL (tsa-ca.pem: the timestamping authority's CA certificate, from its website or the EU trusted list):
  openssl ts -verify -token_in -in NNNNNN.tst -data NNNNNN-manifest.txt -CAfile tsa-ca.pem
Then find this client's line in the manifest and check that the entry with that number in activity-log.csv has that hash.

This client: ${rows.length} timestamp(s), the latest covering entries up to #${last.seq}, issued ${new Date(last.gen_time).toISOString()}.
`) });
  return entries;
}
