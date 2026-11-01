// Passwordless sign-in: a single-use link by email, then a session cookie.
// Tokens and session ids are stored only as SHA-256 hashes.
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { sha256 } from './ledger.js';
import { queueEmail, renderEmail, flushEmails } from './mailer.js';
import { translator, langFor } from './i18n.js';
import { confirmSignup, checkTrialInvites } from './billing.js';

const COOKIE = 'vx_session';

export async function createLoginLink(userId, db = { query }) {
  const token = randomBytes(32).toString('base64url');
  await db.query(`insert into login_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
    [sha256(token), userId, config.loginLinkMinutes]);
  return `${config.appUrl}/auth/verify?token=${token}`;
}

export async function sendLoginLink(client, user, { invitedBy, companyName, companyId, firmName, team } = {}) {
  // invitations count against a trial firm's daily allowance
  if (invitedBy) {
    const firmId = team ? user.firm_id
      : (await client.query('select firm_id from companies where id = $1', [companyId || null])).rows[0]?.firm_id;
    await checkTrialInvites(client, firmId);
  }
  const url = await createLoginLink(user.id, client);
  // the person's language, or that of their firm or company
  const { rows: [c] } = await client.query(
    `select coalesce((select f.country from firms f where f.id = $2), (select co.country from companies co where co.id = $3),
       (select co.country from memberships m join companies co on co.id = m.company_id where m.user_id = $1 order by m.created_at limit 1)) as country`,
    [user.id, user.firm_id || null, companyId || null]);
  const t = translator(langFor(user, c?.country));
  const mins = config.loginLinkMinutes;
  const heading = invitedBy ? t('{who} invited you to {company}', { who: invitedBy, company: companyName }) : t('Sign in to Pescada');
  const lines = team
    ? [t('You have been added to the {firm} team on Pescada, where the firm exchanges documents with its clients and every step is recorded.', { firm: firmName }),
       t('The button below signs you in. It works once and expires in {mins} minutes; you can always request a new link on the sign-in page.', { mins })]
    : invitedBy
      ? [t('You now have access to the {company} workspace on Pescada, where documents are exchanged with {firm} and every step is recorded.', { company: companyName, firm: firmName || t('your accountant') }),
         t('The button below signs you in. It works once and expires in {mins} minutes; you can always request a new link on the sign-in page.', { mins })]
      : [t('Use the button below to sign in. The link works once and expires in {mins} minutes.', { mins }), t('If you did not ask for this, ignore this email.')];
  const footer = firmName ? t('{firm} · Pescada. Documents you exchange there, and every action on them, are recorded in your workspace log.', { firm: firmName })
    : t('Pescada. Documents you exchange there, and every action on them, are recorded in your workspace log.');
  const { html, text } = renderEmail({ heading, lines, button: { label: t('Sign in'), url }, footer });
  await queueEmail(client, { companyId, toUserId: user.id, toEmail: user.email, kind: invitedBy ? 'invite' : 'login', subject: heading, html, text });
}

/** Exchange a login token for a session id. Returns null when the token is unknown, used or expired. */
export async function redeemToken(token, meta) {
  const { rows: [t] } = await query(
    `update login_tokens set used_at = now()
     where token_hash = $1 and used_at is null and expires_at > now()
     returning user_id`, [sha256(String(token || ''))]);
  let u;
  if (t) ({ rows: [u] } = await query('select * from users where id = $1 and disabled_at is null', [t.user_id]));
  else u = await confirmSignup(token); // a sign-up link: the firm is created now
  if (!u) return null;
  const sid = randomBytes(32).toString('base64url');
  const days = u.role === 'accountant' ? config.accountantSessionDays : config.sessionDays;
  // with a second factor set up, the session is not usable until the code is entered
  await query(`insert into sessions (id_hash, user_id, expires_at, user_agent, ip, mfa_pending) values ($1, $2, now() + make_interval(days => $3), $4, $5, $6)`,
    [sha256(sid), u.id, days, String(meta.userAgent || '').slice(0, 300), meta.ip || '', !!u.totp_enabled_at]);
  return sid;
}

export function setSessionCookie(res, sid) {
  res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: config.sessionDays * 864e5, path: '/' });
}
export const sessionCookie = (req) => readCookie(req, COOKIE);

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function loadUser(req, _res, next) {
  const sid = readCookie(req, COOKIE);
  req.user = null;
  req.session = null;
  if (sid) {
    const { rows: [u] } = await query(
      `select u.*, s.id_hash as session_hash, s.mfa_pending, s.last_seen_at, f.require_mfa, f.plan as firm_plan, f.trial_ends_at as firm_trial_ends_at
       from sessions s join users u on u.id = s.user_id left join firms f on f.id = u.firm_id
       where s.id_hash = $1 and s.expires_at > now() and u.disabled_at is null`, [sha256(sid)]);
    if (u && u.role === 'accountant' && Date.now() - new Date(u.last_seen_at) > config.accountantIdleHours * 36e5) {
      // an accountant who has been away too long signs in again
      await query('delete from sessions where id_hash = $1', [u.session_hash]);
    } else if (u) {
      const { session_hash, mfa_pending, last_seen_at, require_mfa, firm_plan, firm_trial_ends_at, ...user } = u;
      req.user = user;
      req.firm = user.firm_id ? { plan: firm_plan, trial_ends_at: firm_trial_ends_at } : null;
      req.session = { hash: session_hash, mfaPending: mfa_pending, mfaSetupRequired: !!require_mfa && user.role === 'accountant' && !user.totp_enabled_at };
      if (Date.now() - new Date(last_seen_at) > 5 * 60e3) await query('update sessions set last_seen_at = now() where id_hash = $1', [session_hash]);
    }
  }
  next();
}

export async function logout(req, res) {
  const sid = readCookie(req, COOKIE);
  if (sid) await query('delete from sessions where id_hash = $1', [sha256(sid)]);
  res.clearCookie(COOKIE, { path: '/' });
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Before the second factor (or its required set-up) only these API paths are open.
const MFA_OPEN = /^\/(me|auth\/mfa|auth\/logout|me\/2fa\/(setup|enable))$/;

export function requireUser(req, _res, next) {
  if (!req.user) throw new HttpError(401, 'Sign in to continue.');
  if (req.session?.mfaPending && !MFA_OPEN.test(req.path)) throw Object.assign(new HttpError(401, 'Enter the code from your authenticator app to continue.'), { code: 'mfa_required' });
  if (req.session?.mfaSetupRequired && !MFA_OPEN.test(req.path)) throw Object.assign(new HttpError(403, 'Your firm requires two-step sign-in. Set it up to continue.'), { code: 'mfa_setup_required' });
  next();
}

/** Cross-site forms cannot set custom headers, so this blocks CSRF on every write. */
export function requireAppHeader(req, _res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-Voixa') !== '1') throw new HttpError(403, 'Missing request header.');
  next();
}

export const actorOf = (user) => ({ type: user.role, id: user.id, name: user.name || user.email });

/** Load a company the user may act in, or fail with 404. */
export const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));

/** A company row with its firm's name and country, as every module expects it. */
export const COMPANY_SQL = 'select c.*, f.name as firm_name, f.country as firm_country from companies c join firms f on f.id = c.firm_id';

/** Accountants reach only their own firm's clients; client users only the companies they are members of. */
/**
 * Inside a transaction (db given) the company row is locked first, so every writer takes
 * the company lock before any item lock and concurrent transactions cannot deadlock.
 */
export async function companyFor(user, companyId, db) {
  if (!isUuid(companyId)) throw new HttpError(404, 'Workspace not found.');
  const q = db || { query };
  const lock = db ? ' for update of c' : '';
  const { rows: [c] } = user.role === 'accountant'
    ? await q.query(`${COMPANY_SQL} where c.id = $1 and accountant_sees(c.id, $2) and c.blocked_at is null${lock}`, [companyId, user.id])
    : await q.query(`${COMPANY_SQL} join memberships m on m.company_id = c.id
                      where c.id = $1 and m.user_id = $2 and m.removed_at is null and c.closed_at is null${lock}`, [companyId, user.id]);
  if (!c) throw new HttpError(404, 'Workspace not found.');
  return c;
}

export { flushEmails };
