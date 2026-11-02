// Deadlines across a person's clients: open requests (the client owes a document) and expected
// reports (the firm owes one). Shown in the app and as a private iCal feed for Google or Outlook.
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { tzOf } from './countries.js';

/** Open deadlines between two days (inclusive), plus everything overdue. */
export async function deadlines(user, { from, to, overdue = true }) {
  const visible = user.role === 'accountant' ? 'accountant_sees(c.id, $1)'
    : 'exists (select 1 from memberships m where m.company_id = c.id and m.user_id = $1 and m.removed_at is null)';
  const { rows } = await query(
    `select i.id, i.kind, i.title, i.state, i.due_at, i.seq, c.id as company_id, c.no, c.name as company_name, c.country, c.tags
     from items i join companies c on c.id = i.company_id
     where ${visible} and c.closed_at is null and c.blocked_at is null and i.due_at is not null
       and ((i.kind = 'request' and i.state <> 'done') or (i.kind = 'report' and i.state = 'expected'))
       and (i.due_at < $3::date + 1 ${overdue ? 'and (i.due_at >= $2::date or i.due_at < now())' : 'and i.due_at >= $2::date'})
     order by i.due_at, c.no`, [user.id, from, to]);
  return rows.map((r) => ({ ...r, tags: user.role === 'accountant' ? r.tags : undefined, overdue: new Date(r.due_at) < new Date() }));
}

/** The person's private feed address, made on first use. */
export async function calendarUrl(user, { reset = false } = {}) {
  let token = user.calendar_token;
  if (!token || reset) {
    token = randomBytes(24).toString('base64url');
    await query('update users set calendar_token = $2 where id = $1', [user.id, token]);
  }
  return `${config.appUrl}/calendar/${token}.ics`;
}

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// lines longer than 75 octets are folded, as iCalendar requires
const fold = (line) => {
  const out = []; let buf = Buffer.from(line, 'utf8');
  while (buf.length > 75) { let n = 75; while ((buf[n] & 0xc0) === 0x80) n--; out.push(buf.subarray(0, n).toString('utf8')); buf = Buffer.concat([Buffer.from(' '), buf.subarray(n)]); }
  out.push(buf.toString('utf8'));
  return out.join('\r\n');
};
const ymd = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');

/** The iCal feed behind a calendar link: all-day events for the next year and anything overdue. */
export async function icsFor(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const { rows: [user] } = await query('select * from users where calendar_token = $1 and disabled_at is null', [token]);
  if (!user) return null;
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 366 * 864e5).toISOString().slice(0, 10);
  const items = await deadlines(user, { from: today, to: end });
  const { rows: [f] } = user.firm_id ? await query('select name from firms where id = $1', [user.firm_id]) : { rows: [] };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pescada//Deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`Pescada${f ? ` · ${f.name}` : ''}`)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const i of items) {
    const tz = tzOf(i.country), day = ymd(new Date(i.due_at), tz);
    const next = ymd(new Date(new Date(i.due_at).getTime() + 864e5), tz);
    const what = i.kind === 'request' ? `${i.company_name}: ${i.title}` : `${i.company_name}: ${i.title} (to send)`;
    lines.push('BEGIN:VEVENT', `UID:${i.id}@pescada.io`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${esc(what)}`, `DESCRIPTION:${esc(`${i.kind === 'request' ? 'Document requested from the client' : 'Report the firm has to send'} · #${i.no}\n${config.appUrl}/#/c/${i.company_id}/i/${i.id}`)}`,
      `URL:${config.appUrl}/#/c/${i.company_id}/i/${i.id}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
