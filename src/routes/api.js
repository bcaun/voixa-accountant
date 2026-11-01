import express from 'express';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { HttpError, companyFor, isUuid, requireUser, sendLoginLink, logout } from '../auth.js';
import { firmEvent } from '../audit.js';
import { scanStored } from '../antivirus.js';
import { inboundAddress } from '../inbound.js';
import { makeZip } from '../zip.js';
import { closeCompany, reopenCompany, exportEverything } from '../closure.js';
import { accountingExport, exportKinds } from '../exports.js';
import { signUp, checkoutUrl, portalUrl, billingOn, firmActive, trialDaysLeft } from '../billing.js';
import { feedsOn, institutions, connect as connectBank, removeConnection } from '../bankfeeds.js';
import { actorOf } from '../auth.js';
import { newSecret, otpauthUri, seal, unseal, verifyTotp, recoveryCodes, hashRecovery } from '../totp.js';
import QRCode from 'qrcode';
import { flushEmails } from '../mailer.js';
import { storage } from '../storage.js';
import { parseUpload, discard } from '../multipart.js';
import { verifyCompany, appendEvent, lockCompany } from '../ledger.js';
import { parseDay } from '../dates.js';
import { COUNTRY_CODES, countryOf, isCountry, publicCountries, tzOf, LANGS, langOfCountry } from '../countries.js';
import * as items from '../items.js';
import * as companies from '../companies.js';
import { exportCsv, exportReport } from '../export.js';
import { processJobs, enqueueRecognition } from '../recognition/recognize.js';
import { decideMatch } from '../recognition/matching.js';

const background = () => processJobs().catch((err) => console.error('recognition', err));

export const api = express.Router();
const json = express.json({ limit: '100kb' });
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

/* ---------- sign-in ---------- */

const attempts = new Map();
function rateLimit(key, max = 5, windowMs = 15 * 60e3, message = 'Too many sign-in requests. Wait a few minutes and try again.') {
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  attempts.set(key, hits);
  if (hits.length > max) throw new HttpError(429, message);
}
// forget old counters now and then
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of attempts) if (!hits.length || now - hits[hits.length - 1] > 60 * 60e3) attempts.delete(k);
}, 10 * 60e3).unref();

api.post('/auth/request', json, async (req, res) => {
  const email = str(req.body?.email, 200).toLowerCase();
  rateLimit(`ip:${req.ip}`, 20);
  rateLimit(`email:${email}`);
  const { rows: [u] } = await query('select * from users where email = $1 and disabled_at is null', [email]);
  if (u) {
    await tx((c) => sendLoginLink(c, u));
    flushEmails().catch((err) => console.error('mail', err));
  }
  // same answer whether or not the address exists
  res.json({ ok: true });
});

// a firm signs itself up: a trial firm and its first administrator, signed in by email link
api.post('/signup', json, async (req, res) => {
  rateLimit(`signup:${req.ip}`, 5, 60 * 60e3, 'Too many sign-ups from here. Try again later.');
  const b = req.body || {};
  await signUp({ firmName: str(b.firmName, 200), country: b.country, name: str(b.name, 200), email: str(b.email, 200) });
  flushEmails().catch((err) => console.error('mail', err));
  res.json({ ok: true });
});

api.post('/auth/logout', async (req, res) => {
  await logout(req, res);
  res.json({ ok: true });
});

api.use(requireUser);

// generous limits that only stop runaway scripts and abuse
api.use((req, _res, next) => {
  if (req.method === 'GET') rateLimit(`read:${req.user.id}`, 1200, 5 * 60e3, 'Too many requests. Wait a minute and try again.');
  else rateLimit(`write:${req.user.id}`, 300, 5 * 60e3, 'Too many changes in a short time. Wait a minute and try again.');
  if (req.method === 'POST' && /\/(documents|reports|versions)$/.test(req.path)) rateLimit(`upload:${req.user.id}`, 120, 10 * 60e3, 'Too many uploads in a short time. Wait a few minutes and try again.');
  next();
});

// When a trial has ended without a subscription, the firm can still sign in, read and export,
// and subscribe; it cannot add or change anything until it does. Clients are not blocked.
api.use((req, _res, next) => {
  if (req.method === 'GET' || req.user.role !== 'accountant' || firmActive(req.firm)) return next();
  if (/^\/(billing|me|auth|firm\/team)/.test(req.path)) return next();
  throw Object.assign(new HttpError(402, 'Your firm’s trial has ended. Subscribe to keep working; everything you have is kept and can be exported.'), { code: 'subscription' });
});

// A closed client is read-only: nothing can be added or changed, only exported (or the client reopened).
api.use(async (req, _res, next) => {
  if (req.method === 'GET') return next();
  const m = /^\/(companies|items)\/([0-9a-f-]{36})(\/[^?]*)?$/i.exec(req.path);
  if (!m || m[3] === '/reopen') return next();
  const { rows: [c] } = m[1] === 'companies'
    ? await query('select closed_at from companies where id = $1', [m[2]])
    : await query('select co.closed_at from items i join companies co on co.id = i.company_id where i.id = $1', [m[2]]);
  if (c?.closed_at) throw new HttpError(409, 'This client is closed. Its workspace can only be exported, or reopened by an administrator.');
  next();
});

/* ---------- who am I ---------- */

api.get('/me', async (req, res) => {
  const u = req.user;
  if (req.session?.mfaPending) {
    return res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, mfa: { enabled: true, pending: true } }, firm: '', companies: [], countries: publicCountries() });
  }
  const { rows } = u.role === 'accountant'
    ? await query('select id, no, name, nif, city, country, closed_at, export_until from companies where firm_id = $1 and accountant_sees(id, $2) and blocked_at is null order by no', [u.firm_id, u.id])
    : await query(`select c.id, c.no, c.name, c.nif, c.city, c.country, f.name as firm_name from companies c
                   join memberships m on m.company_id = c.id join firms f on f.id = c.firm_id
                   where m.user_id = $1 and m.removed_at is null and c.closed_at is null order by f.name, c.no`, [u.id]);
  const firm = u.firm_id ? (await query('select id, name, country, require_mfa, plan, trial_ends_at from firms where id = $1', [u.firm_id])).rows[0] : null;
  if (firm) Object.assign(firm, { trialDaysLeft: trialDaysLeft(firm), active: firmActive(firm), onlinePayment: billingOn() });
  const lang = u.lang || langOfCountry(firm?.country || rows[0]?.country);
  res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, firmRole: u.firm_role || null, lang, langChosen: u.lang || null, notifyMode: items.notifyModeOf(u), digestHour: u.digest_hour,
    mfa: { enabled: !!u.totp_enabled_at, pending: !!req.session?.mfaPending, setupRequired: !!req.session?.mfaSetupRequired, recoveryLeft: (u.recovery_codes || []).length } }, firm: firm?.name || rows[0]?.firm_name || '',
    firmInfo: firm, countries: publicCountries(), companies: rows, features: { bankFeeds: feedsOn() } });
});

/* ---------- my settings ---------- */

api.patch('/me', json, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [req.user.id];
  if (b.name !== undefined) { const n = str(b.name, 200); if (!n) throw new HttpError(400, 'Enter your name.'); vals.push(n); sets.push(`name = $${vals.length}`); }
  if (b.notifyMode !== undefined) {
    if (!['instant', 'digest'].includes(b.notifyMode)) throw new HttpError(400, 'Choose instant emails or a daily summary.');
    vals.push(b.notifyMode); sets.push(`notify_mode = $${vals.length}`);
  }
  if (b.lang !== undefined) {
    if (b.lang !== null && !LANGS.includes(b.lang)) throw new HttpError(400, 'Choose a language.');
    vals.push(b.lang); sets.push(`lang = $${vals.length}`);
  }
  if (b.digestHour !== undefined) {
    const h = Number(b.digestHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new HttpError(400, 'Choose an hour between 0 and 23.');
    vals.push(h); sets.push(`digest_hour = $${vals.length}`);
  }
  if (sets.length) await query(`update users set ${sets.join(', ')} where id = $1`, vals);
  res.json({ ok: true });
});

/* ---------- two-step sign-in ---------- */

api.post('/auth/mfa', json, async (req, res) => {
  const u = req.user;
  if (!req.session?.mfaPending) return res.json({ ok: true });
  rateLimit(`mfa:${u.id}`, 6);
  const code = str(req.body?.code, 40);
  const step = verifyTotp(unseal(u.totp_secret), code);
  if (step != null && step > Number(u.totp_last_step || 0)) {
    await query('update users set totp_last_step = $2 where id = $1', [u.id, step]);
  } else {
    const h = hashRecovery(code);
    const { rowCount } = await query('update users set recovery_codes = array_remove(recovery_codes, $2) where id = $1 and $2 = any(recovery_codes)', [u.id, h]);
    if (!rowCount) throw new HttpError(400, 'That code is not right. Codes change every 30 seconds; use the newest one.');
    await firmEvent({ query }, u.firm_id, u, 'recovery_code_used', `${u.name || u.email} signed in with a recovery code`);
  }
  await query('update sessions set mfa_pending = false where id_hash = $1', [req.session.hash]);
  res.json({ ok: true });
});

api.post('/me/2fa/setup', async (req, res) => {
  const u = req.user;
  if (u.totp_enabled_at) throw new HttpError(409, 'Two-step sign-in is already on.');
  const secret = newSecret();
  await query('update users set totp_pending = $2 where id = $1', [u.id, seal(secret)]);
  const uri = otpauthUri(secret, u.email);
  res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: await QRCode.toString(uri, { type: 'svg', margin: 1 }) });
});

api.post('/me/2fa/enable', json, async (req, res) => {
  const u = req.user;
  if (!u.totp_pending) throw new HttpError(400, 'Start the set-up first.');
  const secret = unseal(u.totp_pending);
  const step = verifyTotp(secret, req.body?.code);
  if (step == null) throw new HttpError(400, 'That code is not right. Check the time on your phone and enter the newest code.');
  const codes = recoveryCodes();
  await query(`update users set totp_secret = totp_pending, totp_pending = null, totp_enabled_at = now(), totp_last_step = $2, recovery_codes = $3 where id = $1`,
    [u.id, step, codes.map(hashRecovery)]);
  await firmEvent({ query }, u.firm_id, u, 'mfa_enabled', `${u.name || u.email} turned on two-step sign-in`);
  res.json({ recoveryCodes: codes });
});

api.post('/me/2fa/disable', json, async (req, res) => {
  const u = req.user;
  if (!u.totp_enabled_at) return res.json({ ok: true });
  const { rows: [f] } = u.firm_id ? await query('select require_mfa from firms where id = $1', [u.firm_id]) : { rows: [] };
  if (f?.require_mfa) throw new HttpError(403, 'Your firm requires two-step sign-in, so it cannot be turned off.');
  if (verifyTotp(unseal(u.totp_secret), req.body?.code) == null) throw new HttpError(400, 'Enter a current code from your authenticator app to turn it off.');
  await query(`update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null, recovery_codes = '{}' where id = $1`, [u.id]);
  await firmEvent({ query }, u.firm_id, u, 'mfa_disabled', `${u.name || u.email} turned off two-step sign-in`);
  res.json({ ok: true });
});

api.post('/me/2fa/recovery', json, async (req, res) => {
  const u = req.user;
  if (!u.totp_enabled_at) throw new HttpError(400, 'Turn on two-step sign-in first.');
  if (verifyTotp(unseal(u.totp_secret), req.body?.code) == null) throw new HttpError(400, 'Enter a current code from your authenticator app.');
  const codes = recoveryCodes();
  await query('update users set recovery_codes = $2 where id = $1', [u.id, codes.map(hashRecovery)]);
  res.json({ recoveryCodes: codes });
});

/* ---------- the firm's team ---------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function teamOf(firmId) {
  const { rows } = await query(
    `select u.id, u.name, u.email, u.firm_role, u.all_clients, u.disabled_at, u.created_at, u.totp_enabled_at is not null as mfa,
            (select max(s.last_seen_at) from sessions s where s.user_id = u.id) as last_seen_at,
            coalesce((select array_agg(a.company_id) from company_assignments a where a.user_id = u.id), '{}') as company_ids
     from users u where u.firm_id = $1 and u.role = 'accountant' order by u.disabled_at nulls first, u.name, u.email`, [firmId]);
  return rows;
}

api.get('/firm/team', async (req, res) => {
  if (req.user.role !== 'accountant') throw new HttpError(403, 'Only accountants can see the team.');
  res.json({ team: await teamOf(req.user.firm_id), me: req.user.id, admin: req.user.firm_role === 'admin' });
});

/** Assignments are only to the firm's own clients. */
async function setAssignments(c, firmId, userId, companyIds) {
  const ids = [...new Set((companyIds || []).filter(isUuid))];
  const { rows } = ids.length ? await c.query('select id from companies where firm_id = $1 and id = any($2)', [firmId, ids]) : { rows: [] };
  await c.query('delete from company_assignments where user_id = $1', [userId]);
  for (const r of rows) await c.query('insert into company_assignments (company_id, user_id) values ($1, $2)', [r.id, userId]);
  return rows.length;
}

api.post('/firm/team', json, async (req, res) => {
  requireAdmin(req.user);
  const b = req.body || {};
  const email = str(b.email, 200).toLowerCase(), name = str(b.name, 200);
  const role = b.role === 'admin' ? 'admin' : 'staff', all = b.allClients !== false;
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const u = await tx(async (c) => {
    const { rows: [f] } = await c.query('select * from firms where id = $1', [req.user.firm_id]);
    const { rows: [existing] } = await c.query('select * from users where email = $1', [email]);
    if (existing && existing.role === 'client') throw new HttpError(409, `${email} is a client’s address in Pescada. Use another address for the accountant.`);
    if (existing && existing.firm_id && existing.firm_id !== f.id) throw new HttpError(409, `${email} already belongs to another firm.`);
    if (existing && !existing.disabled_at) throw new HttpError(409, `${email} is already on the team.`);
    const { rows: [user] } = existing
      ? await c.query(`update users set disabled_at = null, firm_role = $2, all_clients = $3, name = coalesce(nullif($4, ''), name) where id = $1 returning *`, [existing.id, role, all, name])
      : await c.query(`insert into users (email, name, role, firm_id, firm_role, all_clients) values ($1, $2, 'accountant', $3, $4, $5) returning *`, [email, name, f.id, role, all]);
    const n = all ? 0 : await setAssignments(c, f.id, user.id, b.companyIds);
    await sendLoginLink(c, user, { invitedBy: req.user.name || req.user.email, companyName: f.name, firmName: f.name, team: true });
    await firmEvent(c, f.id, req.user, 'member_invited', `${req.user.name || req.user.email} invited ${name || email} (${email}) as ${role === 'admin' ? 'administrator' : 'staff'}, ${all ? 'all clients' : `${n} client${n === 1 ? '' : 's'}`}`, { email, role, all });
    return user;
  });
  flushEmails().catch((err) => console.error('mail', err));
  res.status(201).json({ id: u.id });
});

api.patch('/firm/team/:id', json, async (req, res) => {
  requireAdmin(req.user);
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Not on the team.');
  const b = req.body || {};
  await tx(async (c) => {
    const { rows: [m] } = await c.query(`select * from users where id = $1 and firm_id = $2 and role = 'accountant' for update`, [req.params.id, req.user.firm_id]);
    if (!m) throw new HttpError(404, 'Not on the team.');
    const changes = [];
    const role = b.role === undefined ? m.firm_role : b.role === 'admin' ? 'admin' : 'staff';
    const disable = b.disabled === undefined ? !!m.disabled_at : !!b.disabled;
    if ((role !== 'admin' || disable) && m.firm_role === 'admin' && !m.disabled_at) {
      const { rows: [x] } = await c.query(`select count(*)::int as n from users where firm_id = $1 and role = 'accountant' and firm_role = 'admin' and disabled_at is null and id <> $2`, [req.user.firm_id, m.id]);
      if (!x.n) throw new HttpError(409, 'The firm needs at least one active administrator.');
    }
    if (role !== m.firm_role) changes.push(`role ${m.firm_role} → ${role}`);
    let all = m.all_clients;
    if (b.allClients !== undefined) {
      all = !!b.allClients;
      const n = all ? (await c.query('delete from company_assignments where user_id = $1', [m.id]), 0) : await setAssignments(c, req.user.firm_id, m.id, b.companyIds);
      changes.push(all ? 'access to all clients' : `access to ${n} client${n === 1 ? '' : 's'}`);
    }
    if (disable !== !!m.disabled_at) changes.push(disable ? 'account disabled' : 'account enabled again');
    await c.query('update users set firm_role = $2, all_clients = $3, disabled_at = $4 where id = $1', [m.id, role, all, disable ? (m.disabled_at || new Date()) : null]);
    if (disable) await c.query('delete from sessions where user_id = $1', [m.id]);
    if (changes.length) await firmEvent(c, req.user.firm_id, req.user, 'member_updated', `${req.user.name || req.user.email} changed ${m.name || m.email}: ${changes.join(', ')}`, { user_id: m.id, role, all, disabled: disable });
  });
  res.json({ ok: true });
});

/* ---------- billing ---------- */

api.get('/billing', async (req, res) => {
  requireAdmin(req.user);
  const { rows: [f] } = await query('select plan, trial_ends_at, stripe_customer_id is not null as has_customer from firms where id = $1', [req.user.firm_id]);
  res.json({ plan: f.plan, trialEndsAt: f.trial_ends_at, trialDaysLeft: trialDaysLeft(f), onlinePayment: billingOn(), hasCustomer: f.has_customer });
});
api.post('/billing/checkout', async (req, res) => { requireAdmin(req.user); res.json({ url: await checkoutUrl(req.user) }); });
api.post('/billing/portal', async (req, res) => { requireAdmin(req.user); res.json({ url: await portalUrl(req.user) }); });

/* ---------- my sessions ---------- */

api.get('/me/sessions', async (req, res) => {
  const { rows } = await query('select id_hash, created_at, last_seen_at, user_agent, ip from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc', [req.user.id]);
  res.json({ sessions: rows.map((s) => ({ id: s.id_hash.slice(0, 16), created_at: s.created_at, last_seen_at: s.last_seen_at, device: s.user_agent, ip: s.ip, current: s.id_hash === req.session.hash })) });
});
api.delete('/me/sessions/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(404, 'Session not found.');
  await query('delete from sessions where user_id = $1 and left(id_hash, 16) = $2 and id_hash <> $3', [req.user.id, id, req.session.hash]);
  res.json({ ok: true });
});
api.post('/me/sessions/sign-out-others', async (req, res) => {
  const { rowCount } = await query('delete from sessions where user_id = $1 and id_hash <> $2', [req.user.id, req.session.hash]);
  await firmEvent({ query }, req.user.firm_id, req.user, 'sessions_revoked', `${req.user.name || req.user.email} signed out ${rowCount} other session${rowCount === 1 ? '' : 's'}`);
  res.json({ signedOut: rowCount });
});

/* ---------- the accountant's firm ---------- */

const requireAdmin = (user) => {
  if (user.role !== 'accountant' || user.firm_role !== 'admin') throw new HttpError(403, 'Only the firm’s administrators can do this.');
};

api.get('/firm/events', async (req, res) => {
  requireAdmin(req.user);
  const { rows } = await query('select at, actor_name, type, text from firm_events where firm_id = $1 order by at desc limit 200', [req.user.firm_id]);
  res.json({ events: rows });
});

api.patch('/firm', json, async (req, res) => {
  requireAdmin(req.user);
  const name = str(req.body?.name, 200), country = req.body?.country;
  if (!name) throw new HttpError(400, 'Enter the firm’s name.');
  if (!isCountry(country)) throw new HttpError(400, `Choose one of: ${COUNTRY_CODES.join(', ')}.`);
  const requireMfa = req.body?.requireMfa === undefined ? null : !!req.body.requireMfa;
  const { rows: [before] } = await query('select name, country, require_mfa from firms where id = $1', [req.user.firm_id]);
  await query('update firms set name = $2, country = $3, require_mfa = coalesce($4, require_mfa) where id = $1', [req.user.firm_id, name, country, requireMfa]);
  const changes = [before.name !== name && `name “${before.name}” → “${name}”`, before.country !== country && `country ${before.country} → ${country}`,
    requireMfa != null && requireMfa !== before.require_mfa && (requireMfa ? 'two-step sign-in now required' : 'two-step sign-in no longer required')].filter(Boolean);
  if (changes.length) await firmEvent({ query }, req.user.firm_id, req.user, 'firm_updated', `${req.user.name || req.user.email} changed the firm: ${changes.join(', ')}`, { name, country, requireMfa });
  res.json({ ok: true });
});

/* ---------- accountant overview ---------- */

api.get('/overview', async (req, res) => {
  if (req.user.role !== 'accountant') throw new HttpError(403, 'Only accountants have an overview.');
  const firmId = req.user.firm_id;
  const uid = req.user.id;
  const { rows: cos } = await query('select id, no, name, nif, city, country, created_at, closed_at, export_until from companies where firm_id = $1 and accountant_sees(id, $2) and blocked_at is null order by no', [firmId, uid]);
  const { rows: open } = await query(
    `select i.id, i.company_id, i.seq, i.kind, i.title, i.category, i.period, i.due_at, i.state, i.version,
            i.sent_at, i.version_at, i.opened_at, i.done_at, i.reminders, c.no, c.name as company_name, c.country
     from items i join companies c on c.id = i.company_id where c.firm_id = $1 and accountant_sees(c.id, $2) and c.closed_at is null and i.state <> 'done' order by i.version_at nulls last`, [firmId, uid]);
  const { rows: members } = await query(
    `select m.company_id, count(*)::int as n from memberships m join companies c on c.id = m.company_id
     where m.removed_at is null and c.firm_id = $1 and accountant_sees(c.id, $2) group by m.company_id`, [firmId, uid]);
  const mcount = Object.fromEntries(members.map((r) => [r.company_id, r.n]));
  res.json({
    companies: cos.map((c) => ({ ...c, members: mcount[c.id] || 0 })),
    open: open.map((i) => ({ ...i, ref: items.refOf({ no: i.no }, i) })),
  });
});

/* ---------- companies ---------- */

api.post('/companies', json, async (req, res) => {
  const b = req.body || {};
  const co = await tx(async (c) => {
    const created = await companies.createCompany(c, { user: req.user, name: str(b.name, 200), nif: str(b.nif, 40), city: str(b.city, 100), country: b.country || undefined });
    if (b.contactEmail) await companies.addMember(c, { user: req.user, company: created, email: b.contactEmail, name: str(b.contactName, 200) });
    return created;
  });
  flushEmails().catch((err) => console.error('mail', err));
  res.status(201).json({ id: co.id });
});

api.patch('/companies/:id', json, async (req, res) => {
  const b = req.body || {};
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    await companies.updateCompany(c, { user: req.user, company, name: str(b.name, 200), nif: b.nif === undefined ? undefined : str(b.nif, 40),
      city: b.city === undefined ? undefined : str(b.city, 100), country: b.country === undefined ? undefined : b.country });
  });
  res.json({ ok: true });
});

api.get('/companies/:id', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  const days = req.query.all === '1' ? null : Math.min(3650, Math.max(7, Number(req.query.days) || 120));
  res.json(await companyState(req.user, company, { days }));
});

/** Cheap check for the polling client: the log only grows, so its head tells whether anything changed. */
api.get('/companies/:id/changes', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  const { rows: [j] } = await query(`select count(*)::int as n from jobs j join items i on i.id = j.item_id where i.company_id = $1 and j.status in ('queued','running')`, [company.id]);
  res.json({ seq: Number(company.head_seq), pending: j.n });
});
api.get('/overview/changes', async (req, res) => {
  if (req.user.role !== 'accountant') throw new HttpError(403, 'Only accountants have an overview.');
  const { rows: [r] } = await query('select coalesce(sum(head_seq), 0)::bigint as seq, count(*)::int as n from companies where firm_id = $1 and accountant_sees(id, $2)', [req.user.firm_id, req.user.id]);
  res.json({ seq: `${r.seq}:${r.n}` });
});

/** The activity log, newest first, a page at a time. */
api.get('/companies/:id/events', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  const before = Number(req.query.before) || Number(company.head_seq) + 1;
  const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 100));
  const { rows } = await query(
    `select e.seq, e.at, e.actor_type, e.actor_name, e.type, e.item_id, e.text, e.hash, i.seq as item_seq
     from events e left join items i on i.id = e.item_id where e.company_id = $1 and e.seq < $2 order by e.seq desc limit $3`, [company.id, before, limit]);
  res.json({ events: rows.map(({ item_seq, ...e }) => ({ ...e, ref: item_seq ? items.refOf(company, { seq: item_seq }) : null })),
    total: Number(company.head_seq), more: rows.length === limit && rows[rows.length - 1].seq > 1 });
});

/**
 * A workspace as the web client shows it. To stay fast as years of documents pile up, it holds
 * everything still open plus what changed in the last `days` days (all of it when days is null).
 */
async function companyState(user, company, { days = 120 } = {}) {
  const [members, obligations, its, counts] = await Promise.all([
    query(`select u.id, u.name, u.email, m.created_at from memberships m join users u on u.id = m.user_id
           where m.company_id = $1 and m.removed_at is null order by m.created_at`, [company.id]),
    query('select * from obligations where company_id = $1 order by active desc, created_at', [company.id]),
    days == null
      ? query('select * from items where company_id = $1 order by seq', [company.id])
      : query(`select * from items where company_id = $1 and (state <> 'done' or coalesce(done_at, version_at, created_at) > now() - make_interval(days => $2)
               or due_at > now() - make_interval(days => $2)) order by seq`, [company.id, days]),
    query(`select count(*)::int as n from items where company_id = $1`, [company.id]),
  ]);
  const ids = its.rows.map((i) => i.id);
  const [vers, emails, evs] = await Promise.all([
    query(`select v.id, v.item_id, v.version, v.file_name, v.mime, v.size, v.sha256, v.uploaded_at, v.replace_reason, v.scan_status, v.scan_signature, u.name as uploaded_by
           from versions v left join users u on u.id = v.uploaded_by where v.item_id = any($1) order by v.version`, [ids]),
    // ordinary notifications, and daily summaries that listed the item
    query(`select item_id, to_email, kind, status, created_at, updated_at from email_messages where item_id = any($1)
           union all
           select x.item_id, m.to_email, m.kind, m.status, m.created_at, m.updated_at from email_items x join email_messages m on m.id = x.email_id
           where x.item_id = any($1) order by created_at`, [ids]),
    query('select seq, at, actor_type, actor_id, actor_name, type, item_id, text, hash, data from events where item_id = any($1) order by seq', [ids]),
  ]);
  const byItem = (rows) => rows.reduce((m, r) => ((m[r.item_id] ||= []).push(r), m), {});
  const vMap = byItem(vers.rows), eMap = byItem(emails.rows), evMap = byItem(evs.rows);
  return {
    company: { id: company.id, no: company.no, name: company.name, nif: company.nif, city: company.city, country: company.country,
      tz: tzOf(company.country), taxIdLabel: countryOf(company.country).taxIdLabel, created_at: company.created_at, inbound_address: company.closed_at ? null : inboundAddress(company),
      closed_at: company.closed_at, export_until: company.export_until, purge_after: company.purge_after },
    firm: company.firm_name,
    seq: Number(company.head_seq),
    window: { days, shown: its.rows.length, total: counts.rows[0].n },
    members: members.rows,
    obligations: obligations.rows.map((o) => ({ ...o, description: companies.describeObligation(o) })),
    items: its.rows.map((i) => {
      const ev = evMap[i.id] || [];
      const status = items.computeStatus(i.kind, ev);
      const mine = ev.some((e) => e.actor_id === user.id && (e.type === 'opened' || e.type === 'downloaded') && status.version_at && new Date(e.at) >= new Date(status.version_at));
      return {
        id: i.id, ref: items.refOf(company, i), kind: i.kind, title: i.title, category: i.category, period: i.period, note: i.note,
        due_at: i.due_at, obligation_id: i.obligation_id, for_request: i.for_request, fulfilled_by: i.fulfilled_by, created_at: i.created_at,
        status, opened_by_me: mine, versions: vMap[i.id] || [], emails: eMap[i.id] || [],
      };
    }),
    // the log entries of the items above (the whole log is paged through /events)
    events: evs.rows.map(({ actor_id, data, ...e }) => e),
  };
}

/* ---------- people ---------- */

api.post('/companies/:id/members', json, async (req, res) => {
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    await companies.addMember(c, { user: req.user, company, email: req.body?.email, name: str(req.body?.name, 200) });
  });
  flushEmails().catch((err) => console.error('mail', err));
  res.status(201).json({ ok: true });
});

api.delete('/companies/:id/members/:userId', async (req, res) => {
  if (!isUuid(req.params.userId)) throw new HttpError(404, 'That person does not have access.');
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    await companies.removeMember(c, { user: req.user, company, userId: req.params.userId });
  });
  res.json({ ok: true });
});

/* ---------- recurring deadlines ---------- */

api.post('/companies/:id/obligations', json, async (req, res) => {
  const b = req.body || {};
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    await companies.createObligation(c, { user: req.user, company, kind: b.kind, title: str(b.title, 200), category: str(b.category, 60),
      frequency: b.frequency, dueDay: b.dueDay, dueMonth: b.dueMonth, monthOffset: b.monthOffset, leadDays: b.leadDays, note: str(b.note, 1000) });
  });
  flushEmails().catch((err) => console.error('mail', err));
  res.status(201).json({ ok: true });
});

api.post('/companies/:id/obligations/:oid/stop', async (req, res) => {
  if (!isUuid(req.params.oid)) throw new HttpError(404, 'Not found.');
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    await companies.stopObligation(c, { user: req.user, company, obligationId: req.params.oid });
  });
  res.json({ ok: true });
});

/* ---------- sending ---------- */

/** Scan every uploaded file; refuse the whole upload if one is infected, and log the attempt. */
async function screen(user, company, files) {
  for (const f of files) f.scan = await scanStored(f.key);
  const bad = files.filter((f) => f.scan.status === 'infected');
  if (!bad.length) return;
  await discard(files);
  await tx(async (c) => {
    await lockCompany(c, company.id);
    for (const f of bad) {
      await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'virus_blocked',
        text: `${actorOf(user).name} tried to upload “${f.name}”, which contains malware (${f.scan.signature}). The file was refused and not stored.`,
        data: { file: f.name, sha256: f.sha256, signature: f.scan.signature } });
    }
  });
  throw Object.assign(new HttpError(422, `“${bad[0].name}” contains a virus (${bad[0].scan.signature}) and was not accepted. Nothing from this upload was sent. Scan your computer and send a clean copy.`), { code: 'virus' });
}

api.post('/companies/:id/documents', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  if (req.user.role !== 'client') throw new HttpError(403, 'Only the client side can send documents.');
  const { fields, files } = await parseUpload(req, `companies/${company.id}`);
  if (!files.length) throw new HttpError(400, 'Choose at least one file to send.');
  await screen(req.user, company, files);
  const requestId = isUuid(fields.requestId) ? fields.requestId : null;
  try {
    await tx(async (c) => {
      await lockCompany(c, company.id);
      for (const file of files) {
        await items.createDocument(c, { user: req.user, company, file, category: str(fields.category, 60) || 'Other',
          period: str(fields.period, 20), note: str(fields.note, 1000), requestId });
      }
    });
  } catch (err) {
    await discard(files);
    throw err;
  }
  flushEmails().catch((err) => console.error('mail', err));
  background();
  res.status(201).json({ sent: files.length });
});

api.post('/companies/:id/reports', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  if (req.user.role !== 'accountant') throw new HttpError(403, 'Only accountants can send reports.');
  const { fields, files } = await parseUpload(req, `companies/${company.id}`, { maxFiles: 1 });
  await screen(req.user, company, files);
  try {
    if (files.length !== 1) throw new HttpError(400, 'Attach the report file.');
    const expectedItemId = isUuid(fields.itemId) ? fields.itemId : null;
    const dueAt = fields.due ? parseDay(fields.due, tzOf(company.country)) : null;
    if (!expectedItemId && !str(fields.title)) throw new HttpError(400, 'Give the report a title.');
    if (fields.due && !dueAt) throw new HttpError(400, 'The deadline is not a valid date.');
    await tx(async (c) => {
      await lockCompany(c, company.id);
      await items.createReport(c, { user: req.user, company, file: files[0], title: str(fields.title, 200),
        category: str(fields.category, 60) || 'Other', dueAt, note: str(fields.note, 1000), expectedItemId });
    });
  } catch (err) {
    await discard(files);
    throw err;
  }
  flushEmails().catch((err) => console.error('mail', err));
  res.status(201).json({ ok: true });
});

api.post('/companies/:id/requests', json, async (req, res) => {
  const b = req.body || {};
  if (!str(b.title)) throw new HttpError(400, 'Describe the document you need.');
  if (!parseDay(b.due)) throw new HttpError(400, 'Set a due date.');
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    const dueAt = parseDay(b.due, tzOf(company.country));
    await items.createRequest(c, { user: req.user, company, title: str(b.title, 200), dueAt, note: str(b.note, 1000) });
  });
  flushEmails().catch((err) => console.error('mail', err));
  res.status(201).json({ ok: true });
});

/* ---------- one item ---------- */

async function itemFor(user, id, c) {
  if (!isUuid(id)) throw new HttpError(404, 'Item not found.');
  const found = await items.loadItem(c || { query }, id);
  const company = await companyFor(user, found.company_id, c);
  // in a transaction: company first (locked by companyFor), then the item
  const item = c ? await items.loadItem(c, id, { lock: true }) : found;
  return { item, company };
}

api.post('/items/:id/versions', async (req, res) => {
  const { company } = await itemFor(req.user, req.params.id);
  const { fields, files } = await parseUpload(req, `companies/${company.id}`, { maxFiles: 1 });
  await screen(req.user, company, files);
  try {
    if (files.length !== 1) throw new HttpError(400, 'Attach the new file.');
    await tx(async (c) => {
      const { item } = await itemFor(req.user, req.params.id, c);
      await items.replaceVersion(c, { user: req.user, company, item, file: files[0], reason: str(fields.reason, 500) });
    });
  } catch (err) {
    await discard(files);
    throw err;
  }
  flushEmails().catch((err) => console.error('mail', err));
  background();
  res.status(201).json({ ok: true });
});

// Types a browser may show inline. Anything else is sent as a download, so an
// uploaded HTML or SVG file can never run script on this site.
const INLINE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/;

api.get('/items/:id/file', async (req, res) => {
  const download = req.query.download === '1';
  const { version } = await tx(async (c) => {
    const { item, company } = await itemFor(req.user, req.params.id, c);
    const n = Number(req.query.v) || item.version;
    const { rows: [version] } = await c.query('select * from versions where item_id = $1 and version = $2', [item.id, n]);
    if (!version) throw new HttpError(404, 'That version does not exist.');
    if (version.scan_status === 'infected') throw new HttpError(410, `This file contains malware (${version.scan_signature}) and cannot be opened. Ask for a clean copy.`);
    await items.logOpen(c, { user: req.user, company, item, version, download });
    return { version };
  });
  const inline = !download && INLINE.test(version.mime);
  const stream = await storage.get(version.storage_key);
  res.set({
    'Content-Type': inline ? version.mime : 'application/octet-stream',
    'Content-Length': String(version.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(version.file_name)}`,
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, no-store',
  });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

/* ---------- closing a client ---------- */

api.post('/companies/:id/close', json, async (req, res) => {
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    if (req.user.role !== 'accountant') throw new HttpError(403, 'Only the firm can close a workspace.');
    if (str(req.body?.confirm, 200) !== company.name) throw new HttpError(400, 'Type the client’s name exactly to confirm.');
    await closeCompany(c, { user: req.user, company, reason: str(req.body?.reason, 300) });
  });
  flushEmails().catch((err) => console.error('mail', err));
  res.json({ ok: true });
});
api.post('/companies/:id/reopen', async (req, res) => {
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    if (req.user.role !== 'accountant') throw new HttpError(403, 'Only the firm can reopen a workspace.');
    await reopenCompany(c, { user: req.user, company });
  });
  res.json({ ok: true });
});
api.get('/companies/:id/export-all', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  if (req.user.role !== 'accountant') throw new HttpError(403, 'Only the firm can export a whole workspace.');
  const zip = await exportEverything(company, req.user);
  await tx(async (c) => {
    await lockCompany(c, company.id);
    await appendEvent(c, { companyId: company.id, actor: actorOf(req.user), type: 'exported', text: `${actorOf(req.user).name} downloaded a full export of the workspace (all files, log and report)` });
  });
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="pescada-${String(company.no).padStart(3, '0')}-full-export.zip"`, 'Cache-Control': 'private, no-store' });
  res.send(zip);
});

/* ---------- bank connections (open banking) ---------- */

api.get('/companies/:id/bank', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  const { rows } = await query(`select id, institution_name, status, accounts, linked_at, expires_at, last_sync_at, last_error from bank_connections
                                where company_id = $1 and status <> 'removed' order by created_at desc`, [company.id]);
  res.json({ enabled: feedsOn(), connections: rows.map((r) => ({ ...r, accounts: r.accounts.map((a) => ({ iban: a.iban ? `${a.iban.slice(0, 4)} …${a.iban.slice(-4)}` : null, currency: a.currency })) })) });
});
api.get('/companies/:id/bank/institutions', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  res.json({ institutions: await institutions(company.country) });
});
api.post('/companies/:id/bank/connect', json, async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  res.json({ url: await connectBank({ user: req.user, company, institutionId: str(req.body?.institutionId, 100) }) });
});
api.delete('/companies/:id/bank/:cid', async (req, res) => {
  if (!isUuid(req.params.cid)) throw new HttpError(404, 'That bank connection does not exist.');
  const company = await companyFor(req.user, req.params.id);
  await removeConnection({ user: req.user, company, id: req.params.cid });
  res.json({ ok: true });
});

/* ---------- exports for accounting software ---------- */

api.get('/companies/:id/accounting-export', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  if (req.user.role !== 'accountant') throw new HttpError(403, 'Only accountants can export for accounting software.');
  const kind = String(req.query.kind || '');
  if (!exportKinds(company.country).includes(kind)) throw new HttpError(400, `Choose one of: ${exportKinds(company.country).join(', ')}.`);
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const out = await accountingExport(company, { kind, from: d(req.query.from), to: d(req.query.to), lang: req.query.lang,
    datev: { consultant: req.query.consultant, client: req.query.client, bank: req.query.bank, debtor: req.query.debtor, creditor: req.query.creditor, accountLength: req.query.accountLength } });
  await tx(async (c) => {
    await lockCompany(c, company.id);
    await appendEvent(c, { companyId: company.id, actor: actorOf(req.user), type: 'exported', text: `${actorOf(req.user).name} exported ${kind === 'datev' ? 'a DATEV booking batch' : kind === 'bank' ? 'the bank movements' : 'the invoice register'} for accounting software` });
  });
  res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'private, no-store' });
  res.send(out.body);
});

/* ---------- several items at once ---------- */

async function readAll(stream) { const chunks = []; for await (const ch of stream) chunks.push(ch); return Buffer.concat(chunks); }

/**
 * Download the current files of several items as one ZIP (?ids=…, or ?period=YYYY-MM, or neither for
 * everything shown). Each file counts as downloaded by this person and is logged as such.
 */
api.get('/companies/:id/archive', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  const ids = String(req.query.ids || '').split(',').filter(isUuid);
  const period = /^\d{4}-(\d{2}|Q[1-4])$/.test(String(req.query.period || '')) ? String(req.query.period) : null;
  const { rows: list } = await query(
    `select i.*, v.id as version_id, v.version as vno, v.file_name, v.storage_key, v.size, v.sha256, v.scan_status
     from items i join versions v on v.item_id = i.id and v.version = i.version
     where i.company_id = $1 and ($2::uuid[] is null or i.id = any($2)) and ($3::text is null or i.period = $3 or to_char(v.uploaded_at, 'YYYY-MM') = $3)
     order by i.seq limit 300`, [company.id, ids.length ? ids : null, period]);
  const files = list.filter((x) => x.scan_status !== 'infected');
  const total = files.reduce((a, x) => a + Number(x.size), 0);
  if (!files.length) throw new HttpError(404, 'There are no files to download.');
  if (total > 400 * 1048576) throw new HttpError(413, 'That is more than 400 MB. Choose fewer documents or one month at a time.');
  const entries = [];
  for (const x of files) entries.push({ name: `${items.refOf(company, x)} ${x.file_name}`, data: await readAll(await storage.get(x.storage_key)) });
  const manifest = ['ref,title,file,version,sha256', ...files.map((x) => [items.refOf(company, x), x.title, x.file_name, x.vno, x.sha256].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\r\n');
  entries.push({ name: 'manifest.csv', data: Buffer.from('\ufeff' + manifest + '\r\n') });
  await tx(async (c) => {
    await lockCompany(c, company.id);
    for (const x of files) {
      await items.logOpen(c, { user: req.user, company, item: x, version: { id: x.version_id, version: x.vno, file_name: x.file_name, sha256: x.sha256 }, download: true });
    }
  });
  const name = `pescada-${String(company.no).padStart(3, '0')}-${period || new Date().toISOString().slice(0, 10)}.zip`;
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' });
  res.send(makeZip(entries));
});

/** Confirm receipt (or approve) several items. Only those opened since their current version are confirmed. */
api.post('/companies/:id/confirm-many', json, async (req, res) => {
  const ids = (req.body?.ids || []).filter(isUuid).slice(0, 300);
  const confirmed = [], skipped = [];
  for (const id of ids) {
    try {
      await tx(async (c) => {
        const { item, company } = await itemFor(req.user, id, c);
        if (company.id !== req.params.id) throw new HttpError(404, 'Not in this workspace.');
        await items.confirm(c, { user: req.user, company, item });
      });
      confirmed.push(id);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      skipped.push({ id, reason: err.message });
    }
  }
  flushEmails().catch((err) => console.error('mail', err));
  res.json({ confirmed, skipped });
});

/* ---------- search ---------- */

api.get('/search', async (req, res) => {
  const q = str(req.query.q, 100);
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const ref = /^PX-?(\d{1,4})-?(\d{1,5})$/i.exec(q.replace(/\s/g, ''));
  const visible = req.user.role === 'accountant'
    ? 'accountant_sees(c.id, $2)'
    : 'exists (select 1 from memberships m where m.company_id = c.id and m.user_id = $2 and m.removed_at is null)';
  const { rows } = await query(
    `select distinct on (i.id) i.id, i.seq, i.kind, i.title, i.category, i.state, i.due_at, i.version_at, c.id as company_id, c.no, c.name as company_name,
            v.file_name, d.invoice_number
     from items i join companies c on c.id = i.company_id
     left join versions v on v.item_id = i.id
     left join invoice_data d on d.item_id = i.id
     where ${visible} and (i.title ilike $1 or v.file_name ilike $1 or d.invoice_number ilike $1 or d.issuer_name ilike $1 or d.recipient_name ilike $1
       or c.name ilike $1 ${ref ? 'or (c.no = $3 and i.seq = $4)' : ''})
     order by i.id, i.version_at desc nulls last limit 60`,
    ref ? [like, req.user.id, Number(ref[1]), Number(ref[2])] : [like, req.user.id]);
  rows.sort((a, b) => new Date(b.version_at || 0) - new Date(a.version_at || 0));
  res.json({ results: rows.map((r) => ({ id: r.id, ref: items.refOf({ no: r.no }, r), kind: r.kind, title: r.title, category: r.category, state: r.state,
    company_id: r.company_id, company_name: r.company_name, file_name: r.file_name, invoice_number: r.invoice_number })) });
});

const simple = (fn) => async (req, res) => {
  await tx(async (c) => {
    const { item, company } = await itemFor(req.user, req.params.id, c);
    await fn(c, { user: req.user, company, item, message: str(req.body?.message, 2000) });
  });
  flushEmails().catch((err) => console.error('mail', err));
  res.json({ ok: true });
};

api.post('/items/:id/seen', json, simple(items.markSeen));
api.post('/items/:id/confirm', json, simple(items.confirm));
api.post('/items/:id/changes', json, simple(items.requestChanges));
api.post('/items/:id/comments', json, simple(items.comment));
api.post('/items/:id/remind', json, simple(items.remind));

/* ---------- log ---------- */

api.get('/companies/:id/verify', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  res.json(await verifyCompany({ query }, company.id));
});

async function logExport(user, company, what) {
  await tx((c) => appendEvent(c, { companyId: company.id, actor: { type: user.role, id: user.id, name: user.name || user.email },
    type: 'exported', text: `${user.name || user.email} exported ${what}`, data: { what } }));
}

api.get('/companies/:id/export.csv', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  await logExport(req.user, company, 'the activity log (CSV)');
  const { filename, body } = await exportCsv(company);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send(body);
});

api.get('/companies/:id/report', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  const itemId = isUuid(req.query.item) ? req.query.item : null;
  if (itemId) {
    const { rows } = await query('select 1 from items where id = $1 and company_id = $2', [itemId, company.id]);
    if (!rows.length) throw new HttpError(404, 'Item not found.');
  }
  await logExport(req.user, company, itemId ? 'a tracking report for one item' : 'the workspace tracking report');
  res.set({ 'Content-Type': 'text/html; charset=utf-8' });
  res.send(await exportReport(company, { itemId, by: req.user }));
});

/* ---------- recognised bank data and payment matches ---------- */

const num2 = (v) => (v == null ? null : Number(v));

api.get('/companies/:id/recognition', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  const cur = 'join items i on i.id = e.item_id join versions v on v.id = e.version_id and v.version = i.version';
  const [ex, txs, invs, matches, pending, usage] = await Promise.all([
    query(`select e.item_id, e.version_id, e.kind, e.status, e.method, e.model, e.summary, e.error, e.created_at from extractions e ${cur} where e.company_id = $1`, [company.id]),
    query(`select t.* from bank_transactions t join extractions e on e.id = t.extraction_id ${cur} where t.company_id = $1 order by t.booking_date nulls last, t.line`, [company.id]),
    query(`select d.* from invoice_data d join extractions e on e.id = d.extraction_id ${cur} where d.company_id = $1`, [company.id]),
    query(`select id, transaction_id, invoice_item_id, score, reasons, status, decided_at from payment_matches where company_id = $1 and status <> 'rejected'`, [company.id]),
    query(`select distinct j.item_id from jobs j join items i on i.id = j.item_id where i.company_id = $1 and j.status in ('queued','running')`, [company.id]),
    // AI costs are the firm's business, not the client's
    req.user.role === 'accountant'
      ? query(`select item_id, count(*)::int as calls, sum(input_tokens + cache_write_tokens + cache_read_tokens)::int as input_tokens,
                 sum(output_tokens)::int as output_tokens, sum(cost_usd)::float as cost_usd
               from ai_usage where company_id = $1 group by item_id`, [company.id])
      : { rows: [] },
  ]);
  res.json({
    extractions: ex.rows,
    transactions: txs.rows.map(({ extraction_id, company_id, ...t }) => ({ ...t, amount: num2(t.amount) })),
    invoices: invs.rows.map(({ extraction_id, company_id, ...d }) => ({ ...d, net_amount: num2(d.net_amount), tax_amount: num2(d.tax_amount), total_amount: num2(d.total_amount) })),
    matches: matches.rows,
    pending: pending.rows.map((r) => r.item_id),
    usage: usage.rows,
  });
});

for (const [path, confirm] of [['confirm', true], ['reject', false]]) {
  api.post(`/companies/:id/matches/:mid/${path}`, async (req, res) => {
    if (!isUuid(req.params.mid)) throw new HttpError(404, 'That match does not exist.');
    await tx(async (c) => {
      const company = await companyFor(req.user, req.params.id, c);
      await decideMatch(c, { user: req.user, company, matchId: req.params.mid, confirm });
    });
    res.json({ ok: true });
  });
}

// Read a file again, or read it as a different type ("statement" or "invoice")
api.post('/items/:id/recognise', json, async (req, res) => {
  const as = req.body?.as;
  if (!['statement', 'invoice'].includes(as)) throw new HttpError(400, 'Choose whether to read the file as a bank statement or an invoice.');
  await tx(async (c) => {
    const { item } = await itemFor(req.user, req.params.id, c);
    if (item.kind !== 'doc') throw new HttpError(400, 'Only documents from the client are read automatically.');
    const { rows: [v] } = await c.query('select * from versions where item_id = $1 and version = $2', [item.id, item.version]);
    await enqueueRecognition(c, item, v, as);
  });
  background();
  res.status(202).json({ ok: true });
});

/* ---------- AI reading costs (accountants) ---------- */

function usageMonth(q) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(q || ''));
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, 1)) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { month: d.toISOString().slice(0, 7), from: d, to: next };
}

async function usageReport(req) {
  requireAdmin(req.user);
  const { month, from, to } = usageMonth(req.query.month);
  const firmId = req.user.firm_id;
  const [byCompany, byModel, months, thisMonth] = await Promise.all([
    query(`select c.id as company_id, c.no, c.name, count(distinct u.version_id)::int as documents, count(*)::int as calls,
             count(*) filter (where u.outcome <> 'ok')::int as unsuccessful,
             sum(u.input_tokens + u.cache_write_tokens + u.cache_read_tokens)::bigint as input_tokens, sum(u.output_tokens)::bigint as output_tokens,
             sum(u.cost_usd)::float as cost_usd
           from ai_usage u join companies c on c.id = u.company_id
           where c.firm_id = $3 and accountant_sees(c.id, $4) and u.created_at >= $1 and u.created_at < $2 group by c.id order by cost_usd desc`, [from, to, firmId, req.user.id]),
    query(`select u.model, u.kind, count(*)::int as calls, sum(u.input_tokens + u.cache_write_tokens + u.cache_read_tokens)::bigint as input_tokens,
             sum(u.output_tokens)::bigint as output_tokens, sum(u.cost_usd)::float as cost_usd
           from ai_usage u join companies c on c.id = u.company_id
           where c.firm_id = $3 and u.created_at >= $1 and u.created_at < $2 group by u.model, u.kind order by u.model, u.kind`, [from, to, firmId]),
    query(`select distinct to_char(date_trunc('month', u.created_at), 'YYYY-MM') as m from ai_usage u join companies c on c.id = u.company_id
           where c.firm_id = $1 order by m desc limit 24`, [firmId]),
    query(`select coalesce(sum(u.cost_usd), 0)::float as spent from ai_usage u join companies c on c.id = u.company_id
           where c.firm_id = $1 and u.created_at >= date_trunc('month', now())`, [firmId]),
  ]);
  const rows = byCompany.rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens) }));
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  return {
    month, months: months.rows.map((r) => r.m), budget_usd: config.recognition.monthlyBudgetUsd || null, spent_this_month_usd: thisMonth.rows[0].spent,
    total: { documents: sum('documents'), calls: sum('calls'), input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cost_usd: sum('cost_usd') },
    companies: rows,
    models: byModel.rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens) })),
  };
}

api.get('/ai-usage', async (req, res) => res.json(await usageReport(req)));

api.get('/ai-usage.csv', async (req, res) => {
  const r = await usageReport(req);
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [['month', 'client_no', 'client', 'documents', 'ai_calls', 'unsuccessful_calls', 'input_tokens', 'output_tokens', 'cost_usd'].join(',')];
  for (const c of r.companies) lines.push([r.month, c.no, c.name, c.documents, c.calls, c.unsuccessful, c.input_tokens, c.output_tokens, c.cost_usd.toFixed(4)].map(cell).join(','));
  lines.push([r.month, '', 'TOTAL', r.total.documents, r.total.calls, '', r.total.input_tokens, r.total.output_tokens, r.total.cost_usd.toFixed(4)].map(cell).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="pescada-ai-usage-${r.month}.csv"` });
  res.send('\ufeff' + lines.join('\r\n') + '\r\n');
});
