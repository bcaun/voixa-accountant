// Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), the codes
// shown by Google Authenticator, 1Password, Microsoft Authenticator and the like. Secrets are
// stored encrypted (AES-256-GCM) with a key that is not in the database.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpAt(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

/** Check a code, allowing one step of clock drift either way. Returns the step that matched (to refuse reuse) or null. */
export function verifyTotp(secretB32, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const expected = Buffer.from(totpAt(secretB32, step + d));
    if (timingSafeEqual(expected, Buffer.from(c))) return step + d;
  }
  return null;
}

export const newSecret = () => base32(randomBytes(20));
export const otpauthUri = (secret, account, issuer = 'Pescada') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* ---------- encryption at rest ---------- */

// SECRET_KEY if set; otherwise derived from the database password, which lives in the server's
// environment and not in the database or its backups.
// Secrets sealed before SECRET_KEY was set still open with the derived key.
const derived = () => createHash('sha256').update(`pescada-totp:${config.databaseUrl}`).digest();
const key = () => (config.secretKey ? createHash('sha256').update(config.secretKey).digest() : derived());
export function seal(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
export function unseal(sealed) {
  const [v, iv, tag, enc] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  for (const k of [key(), derived()]) {
    try {
      const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
    } catch { /* try the next key */ }
  }
  throw new Error('This secret cannot be opened with the server’s keys');
}

/** Ten single-use recovery codes like 7KQ4-M2XD. Only their hashes are stored. */
export function recoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const s = base32(randomBytes(5)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
export const hashRecovery = (code) => createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
