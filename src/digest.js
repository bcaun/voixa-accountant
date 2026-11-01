// The daily digest: notifications collected for people who chose it (accountants by default)
// go out in one email a day, at their chosen hour in their firm's time zone. An entry that has
// waited more than a day is sent with the next run whatever the hour.
import { config } from './config.js';
import { pool, tx } from './db.js';
import { renderEmail } from './mailer.js';
import { tzOf } from './countries.js';
import { refOf } from './items.js';

const localParts = (d, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
};

/** Is this person's digest due at `now`? */
export function digestDue(u, now, oldestEntryAt) {
  const tz = tzOf(u.country);
  const here = localParts(now, tz);
  if (oldestEntryAt && now - new Date(oldestEntryAt) > 26 * 36e5) return true;
  if (here.hour < u.digest_hour) return false;
  return !u.last_digest_at || localParts(new Date(u.last_digest_at), tz).day < here.day;
}

/** Send every digest that is due. `force` sends all pending ones now (tests, manual runs). */
export async function sendDigests(now = new Date(), { force = false } = {}) {
  const { rows: people } = await pool.query(
    `select u.id, u.email, u.name, u.digest_hour, u.last_digest_at, coalesce(f.country, 'ES') as country, f.name as firm_name,
            min(d.created_at) as oldest
     from digest_entries d join users u on u.id = d.user_id left join firms f on f.id = u.firm_id
     where d.email_id is null and u.disabled_at is null group by u.id, f.id`);
  let sent = 0;
  for (const u of people) {
    if (!force && !digestDue(u, now, u.oldest)) continue;
    await tx(async (c) => {
      const { rows: entries } = await c.query(
        `select d.*, co.name as company_name, co.no as company_no, i.title as item_title, i.seq as item_seq
         from digest_entries d join companies co on co.id = d.company_id left join items i on i.id = d.item_id
         where d.user_id = $1 and d.email_id is null order by co.no, d.created_at for update of d`, [u.id]);
      if (!entries.length) return;
      const byCompany = new Map();
      for (const e of entries) {
        if (!byCompany.has(e.company_id)) byCompany.set(e.company_id, []);
        byCompany.get(e.company_id).push(e);
      }
      const lines = [];
      for (const list of byCompany.values()) {
        const first = list[0];
        lines.push(`${first.company_name} (#${first.company_no}): ${list.length} update${list.length === 1 ? '' : 's'}`);
        for (const e of list) lines.push(`• ${e.item_seq ? `${refOf({ no: first.company_no }, { seq: e.item_seq })} ` : ''}${e.line}`);
      }
      const n = entries.length, m = byCompany.size;
      const subject = `Pescada daily summary: ${n} update${n === 1 ? '' : 's'} from ${m} client${m === 1 ? '' : 's'}`;
      const { html, text } = renderEmail({
        heading: 'Your daily summary', lines,
        button: { label: 'Open Pescada', url: `${config.appUrl}/` },
        footer: `${u.firm_name ? `${u.firm_name} · ` : ''}Pescada. Every item listed is marked as notified in its workspace log when this email is sent. You can switch to one email per event in your account settings.`,
      });
      const { rows: [msg] } = await c.query(
        `insert into email_messages (company_id, item_id, to_user_id, to_email, kind, subject, html, body_text)
         values (null, null, $1, $2, 'digest', $3, $4, $5) returning id`, [u.id, u.email, subject, html, text]);
      const seen = new Set();
      for (const e of entries) {
        const key = `${e.company_id}:${e.item_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await c.query('insert into email_items (email_id, company_id, item_id) values ($1,$2,$3)', [msg.id, e.company_id, e.item_id]);
      }
      await c.query('update digest_entries set email_id = $2 where user_id = $1 and email_id is null', [u.id, msg.id]);
      await c.query('update users set last_digest_at = $2 where id = $1', [u.id, now]);
      sent++;
    });
  }
  return sent;
}
