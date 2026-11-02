// Sign in with Google or Microsoft (OpenID Connect, authorization code flow with PKCE).
// An outside account only signs in a person it has been linked to. Linking happens from Your account
// while signed in; a Google account whose verified email is the person's Pescada address links itself
// on first use. Microsoft accounts are never matched by email, because their email claim is not
// guaranteed to be verified.
import { randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';
import { query, tx } from './db.js';
import { HttpError } from './auth.js';
import { firmEvent } from './audit.js';

export const PROVIDERS = ['google', 'microsoft'];
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const cfg = (p) => config.oauth[p];
export const providerOn = (p) => PROVIDERS.includes(p) && !!(cfg(p).clientId && cfg(p).clientSecret);
export const enabledProviders = () => Object.fromEntries(PROVIDERS.map((p) => [p, providerOn(p)]));
const redirectUri = (p) => `${config.appUrl}/auth/oauth/${p}/callback`;
const endpoints = (p) => {
  const c = cfg(p);
  if (p === 'google') return { auth: c.authUrl, token: c.tokenUrl };
  const base = `https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0`;
  return { auth: c.authUrl || `${base}/authorize`, token: c.tokenUrl || `${base}/token` };
};

/** Where to send the browser to sign in at the provider. mode is 'signin', or 'link' for a signed-in person. */
export async function startUrl(provider, { mode, user, lang }) {
  if (!providerOn(provider)) throw new HttpError(404, 'This sign-in method is not available.');
  if (mode === 'link' && !user) throw new HttpError(401, 'Sign in first.');
  const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(32)), nonce = b64url(randomBytes(16));
  await query(`delete from auth_challenges where expires_at < now()`);
  await query(`insert into auth_challenges (id, kind, user_id, data, expires_at) values ($1, 'oauth', $2, $3, now() + interval '10 minutes')`,
    [state, mode === 'link' ? user.id : null, { provider, mode, verifier, nonce, lang }]);
  const q = new URLSearchParams({
    client_id: cfg(provider).clientId, response_type: 'code', redirect_uri: redirectUri(provider), scope: 'openid email profile',
    state, nonce, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account',
  });
  return `${endpoints(provider).auth}?${q}`;
}

/** The provider sent the browser back: check everything, then return what to do. */
export async function finish(provider, { code, state, currentUser }) {
  const { rows: [st] } = await query(`delete from auth_challenges where id = $1 and kind = 'oauth' and expires_at > now() returning *`, [String(state || '')]);
  if (!st || st.data.provider !== provider) throw new HttpError(400, 'This sign-in has expired. Start again.');
  const res = await fetch(endpoints(provider).token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code || ''), redirect_uri: redirectUri(provider),
      client_id: cfg(provider).clientId, client_secret: cfg(provider).clientSecret, code_verifier: st.data.verifier }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) throw new HttpError(400, `${provider === 'google' ? 'Google' : 'Microsoft'} did not confirm the sign-in.`);
  // The ID token comes straight from the provider's token endpoint over TLS, so its claims are trusted
  // as they are (OpenID Connect Core 3.1.3.7); issuer, audience, nonce and expiry are still checked.
  const claims = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  const issOk = provider === 'google' ? ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)
    : /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(claims.iss || '') && claims.iss.includes(claims.tid);
  if (!issOk || claims.aud !== cfg(provider).clientId || claims.nonce !== st.data.nonce || !claims.sub || !(claims.exp * 1000 > Date.now())) {
    throw new HttpError(400, 'The sign-in could not be checked. Start again.');
  }
  const subject = provider === 'microsoft' ? `${claims.tid}:${claims.sub}` : claims.sub;
  const email = String(claims.email || claims.preferred_username || '').toLowerCase();
  const label = provider === 'google' ? 'Google' : 'Microsoft';

  if (st.data.mode === 'link') {
    if (!currentUser || currentUser.id !== st.user_id) throw new HttpError(401, 'Sign in to Pescada first, then link the account again.');
    await tx(async (c) => {
      const { rows: [other] } = await c.query('select user_id from user_identities where provider = $1 and subject = $2', [provider, subject]);
      if (other && other.user_id !== currentUser.id) throw new HttpError(409, `This ${label} account is already linked to another Pescada account.`);
      await c.query(`insert into user_identities (provider, subject, user_id, email) values ($1, $2, $3, $4)
                     on conflict (provider, subject) do update set email = excluded.email`, [provider, subject, currentUser.id, email]);
      if (currentUser.firm_id) await firmEvent(c, currentUser.firm_id, currentUser, 'identity_linked', `${currentUser.name || currentUser.email} linked a ${label} account (${email || subject})`);
    });
    return { linked: true, lang: st.data.lang };
  }

  let { rows: [id] } = await query('select user_id from user_identities where provider = $1 and subject = $2', [provider, subject]);
  if (!id && provider === 'google' && claims.email_verified === true && email) {
    const { rows: [u] } = await query('select id from users where email = $1 and disabled_at is null', [email]);
    if (u) {
      await query(`insert into user_identities (provider, subject, user_id, email) values ($1, $2, $3, $4) on conflict do nothing`, [provider, subject, u.id, email]);
      id = { user_id: u.id };
    }
  }
  if (!id) return { unknown: true, label, lang: st.data.lang };
  await query('update user_identities set last_used_at = now() where provider = $1 and subject = $2', [provider, subject]);
  const { rows: [user] } = await query('select * from users where id = $1 and disabled_at is null', [id.user_id]);
  if (!user) throw new HttpError(403, 'This account is disabled.');
  return { user, lang: st.data.lang };
}

export async function listIdentities(user) {
  const { rows } = await query('select provider, email, created_at, last_used_at from user_identities where user_id = $1 order by created_at', [user.id]);
  return rows;
}
export async function unlink(user, provider) {
  await tx(async (c) => {
    const { rowCount } = await c.query('delete from user_identities where user_id = $1 and provider = $2', [user.id, provider]);
    if (!rowCount) throw new HttpError(404, 'No such linked account.');
    if (user.firm_id) await firmEvent(c, user.firm_id, user, 'identity_unlinked', `${user.name || user.email} unlinked their ${provider === 'google' ? 'Google' : 'Microsoft'} account`);
  });
}
