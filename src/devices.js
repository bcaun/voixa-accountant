// Warn people when their account is signed in from a browser or device it has not been used on before.
// The email carries a one-click "this was not me" link that signs the account out everywhere.
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { query, tx } from './db.js';
import { sha256 } from './ledger.js';
import { queueEmail, renderEmail, flushEmails } from './mailer.js';
import { translator, langFor, timeIn } from './i18n.js';
import { tzOf } from './countries.js';

/** A readable, coarse description of a browser: "Chrome on Windows". Versions are left out on purpose. */
export function describeDevice(ua = '') {
  const s = String(ua);
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\/|CriOS\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows'
    : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'unknown system';
  return `${browser} · ${os}`;
}

/** Record the device of a new session; email the person if it is new and they have signed in before. */
export async function noteDevice(user, meta = {}) {
  const label = describeDevice(meta.userAgent);
  const hash = sha256(label);
  const { rows } = await query('select device_hash from known_devices where user_id = $1', [user.id]);
  await query(`insert into known_devices (user_id, device_hash, label) values ($1, $2, $3)
               on conflict (user_id, device_hash) do update set last_seen = now()`, [user.id, hash, label]);
  if (!rows.length || rows.some((r) => r.device_hash === hash)) return false; // first ever sign-in, or a known device
  await tx(async (c) => {
    const token = randomBytes(32).toString('base64url');
    await c.query(`insert into signin_alerts (token_hash, user_id, expires_at) values ($1, $2, now() + interval '7 days')`, [sha256(token), user.id]);
    const { rows: [k] } = await c.query(
      `select coalesce((select f.country from firms f where f.id = $2),
         (select co.country from memberships m join companies co on co.id = m.company_id where m.user_id = $1 order by m.created_at limit 1)) as country`,
      [user.id, user.firm_id || null]);
    const lang = langFor(user, k?.country);
    const t = translator(lang);
    const heading = t('New sign-in to your Pescada account');
    const { html, text } = renderEmail({
      heading,
      lines: [t('Your account ({email}) was signed in on {time} from {device}, IP address {ip}.', { email: user.email, time: timeIn(new Date(), tzOf(k?.country || 'ES'), lang), device: label, ip: meta.ip || '?' }),
        t('If this was you, there is nothing to do.'),
        t('If it was not you, sign out everywhere with the button below, then write to hello@pescada.io.')],
      button: { label: t('Sign out everywhere'), url: `${config.appUrl}/auth/revoke?token=${token}` },
      footer: t('Pescada. We send this when your account is used on a browser or device for the first time.'),
    });
    await queueEmail(c, { toUserId: user.id, toEmail: user.email, kind: 'signin_alert', subject: heading, html, text });
  });
  flushEmails().catch((err) => console.error('mail', err));
  return true;
}

/** The "this was not me" link: end every session and unused sign-in link of the account. */
export async function revokeFromAlert(token) {
  return tx(async (c) => {
    const { rows: [a] } = await c.query(
      `update signin_alerts set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id`, [sha256(String(token || ''))]);
    if (!a) return null;
    await c.query('delete from sessions where user_id = $1', [a.user_id]);
    await c.query('update login_tokens set used_at = now() where user_id = $1 and used_at is null', [a.user_id]);
    const { rows: [u] } = await c.query('select id, name, email, firm_id from users where id = $1', [a.user_id]);
    if (u?.firm_id) {
      const { firmEvent } = await import('./audit.js');
      await firmEvent(c, u.firm_id, u, 'sessions_revoked', `${u.name || u.email} signed out everywhere from a new-sign-in warning email`);
    }
    return u;
  });
}
