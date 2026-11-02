// Passkeys (WebAuthn): sign in with Face ID, Touch ID, Windows Hello or a security key.
// A passkey proves possession of the device and the person's presence, so it counts as two-step sign-in.
import { randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from './config.js';
import { query, tx } from './db.js';
import { HttpError } from './auth.js';
import { firmEvent } from './audit.js';

const rp = () => { const u = new URL(config.appUrl); return { rpID: u.hostname, origin: u.origin }; };
const CHALLENGE_MINUTES = 5;

async function saveChallenge(kind, userId, challenge) {
  const id = randomBytes(18).toString('base64url');
  await query(`delete from auth_challenges where expires_at < now()`);
  await query(`insert into auth_challenges (id, kind, user_id, data, expires_at) values ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [id, kind, userId, { challenge }, CHALLENGE_MINUTES]);
  return id;
}
async function takeChallenge(id, kind, userId) {
  const { rows: [c] } = await query(`delete from auth_challenges where id = $1 and kind = $2 and expires_at > now() returning *`, [String(id || ''), kind]);
  if (!c || (userId && c.user_id !== userId)) throw new HttpError(400, 'This request has expired. Try again.');
  return c.data.challenge;
}

/** Step 1 of adding a passkey to the signed-in account. */
export async function registrationOptions(user) {
  const { rows } = await query('select id, transports from passkeys where user_id = $1', [user.id]);
  const options = await generateRegistrationOptions({
    rpName: 'Pescada', rpID: rp().rpID,
    userName: user.email, userDisplayName: user.name || user.email, userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: rows.map((r) => ({ id: r.id, transports: r.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  return { options, challengeId: await saveChallenge('passkey-register', user.id, options.challenge) };
}

/** Step 2: check what the browser returned and keep the public key. */
export async function register(user, { challengeId, response, name }) {
  const expectedChallenge = await takeChallenge(challengeId, 'passkey-register', user.id);
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: rp().origin, expectedRPID: rp().rpID, requireUserVerification: false });
  } catch (err) { throw new HttpError(400, `The passkey could not be checked: ${err.message}`); }
  if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'The passkey could not be checked.');
  const cred = v.registrationInfo.credential;
  const label = String(name || '').trim().slice(0, 60) || 'Passkey';
  await tx(async (c) => {
    await c.query(`insert into passkeys (id, user_id, public_key, counter, transports, name) values ($1, $2, $3, $4, $5, $6)`,
      [cred.id, user.id, Buffer.from(cred.publicKey), cred.counter || 0, cred.transports || [], label]);
    if (user.firm_id) await firmEvent(c, user.firm_id, user, 'passkey_added', `${user.name || user.email} added a passkey (${label})`);
  });
  return { id: cred.id };
}

export async function listPasskeys(user) {
  const { rows } = await query('select id, name, created_at, last_used_at from passkeys where user_id = $1 order by created_at', [user.id]);
  return rows;
}

export async function removePasskey(user, id) {
  await tx(async (c) => {
    const { rows: [p] } = await c.query('delete from passkeys where id = $1 and user_id = $2 returning name', [String(id), user.id]);
    if (!p) throw new HttpError(404, 'That passkey does not exist.');
    if (user.firm_id) await firmEvent(c, user.firm_id, user, 'passkey_removed', `${user.name || user.email} removed a passkey (${p.name})`);
  });
}

/** Sign-in step 1: a challenge any of the person's passkeys can answer (the browser offers the ones it has). */
export async function authenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID: rp().rpID, userVerification: 'preferred', allowCredentials: [] });
  return { options, challengeId: await saveChallenge('passkey-signin', null, options.challenge) };
}

/** Sign-in step 2: check the signature and return the person. */
export async function authenticate({ challengeId, response }) {
  const expectedChallenge = await takeChallenge(challengeId, 'passkey-signin');
  const { rows: [p] } = await query(
    `select p.*, u.disabled_at from passkeys p join users u on u.id = p.user_id where p.id = $1`, [String(response?.id || '')]);
  if (!p || p.disabled_at) throw new HttpError(400, 'This passkey is not registered with Pescada. Sign in with an email link and add it in Your account.');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: rp().origin, expectedRPID: rp().rpID, requireUserVerification: false,
      credential: { id: p.id, publicKey: new Uint8Array(p.public_key), counter: Number(p.counter), transports: p.transports },
    });
  } catch (err) { throw new HttpError(400, `The passkey could not be checked: ${err.message}`); }
  if (!v.verified) throw new HttpError(400, 'The passkey could not be checked.');
  await query('update passkeys set counter = $2, last_used_at = now() where id = $1', [p.id, v.authenticationInfo.newCounter]);
  const { rows: [u] } = await query('select * from users where id = $1 and disabled_at is null', [p.user_id]);
  if (!u) throw new HttpError(400, 'This account is disabled.');
  return u;
}
