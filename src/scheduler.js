// Background work: automatic reminders and recurring deadlines. Runs inside
// the web process on a timer; a Postgres advisory lock keeps two servers from
// running it at the same time.
import { config } from './config.js';
import { pool, tx } from './db.js';
import { appendEvent, lockCompany } from './ledger.js';
import { flushEmails } from './mailer.js';
import { generateDue } from './companies.js';
import { SYSTEM, notify, recipientSide, recompute, reminderLine } from './items.js';
import { fmtDay } from './dates.js';
import { tzOf } from './countries.js';
import { COMPANY_SQL } from './auth.js';
import { processJobs } from './recognition/recognize.js';
import { sendDigests } from './digest.js';
import { scanningOn, scanStored } from './antivirus.js';

const LOCK_ID = 774411;

export async function runScheduler(now = new Date()) {
  const lockClient = await pool.connect();
  try {
    const { rows: [l] } = await lockClient.query('select pg_try_advisory_lock($1) as ok', [LOCK_ID]);
    if (!l.ok) return { skipped: true };
    try {
      const generated = await generateObligations(now);
      const reminded = await autoReminders(now);
      await processJobs();
      const rescanned = await rescanPending();
      const digests = await sendDigests(now);
      await flushEmails();
      return { generated, reminded, digests, rescanned };
    } finally {
      await lockClient.query('select pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    lockClient.release();
  }
}

async function generateObligations(now) {
  const { rows } = await pool.query(`select o.*, row_to_json(c) as company from obligations o join (${COMPANY_SQL}) c on c.id = o.company_id where o.active`);
  let n = 0;
  for (const o of rows) {
    const made = await tx((c) => generateDue(c, o, o.company, now));
    if (made) n++;
  }
  return n;
}

const H = 36e5;

/** Files accepted while the virus scanner was down are scanned as soon as it is back. */
export async function rescanPending() {
  if (!scanningOn()) return 0;
  const { rows } = await pool.query(
    `select v.*, i.company_id from versions v join items i on i.id = v.item_id where v.scan_status = 'pending' order by v.uploaded_at limit 50`);
  let n = 0;
  for (const v of rows) {
    const r = await scanStored(v.storage_key);
    if (r.status === 'pending') break; // still down: try again on the next run
    n++;
    await tx(async (c) => {
      await lockCompany(c, v.company_id);
      await c.query('update versions set scan_status = $2, scan_signature = $3, scanned_at = now() where id = $1', [v.id, r.status, r.signature || null]);
      if (r.status !== 'infected') return;
      const { rows: [company] } = await c.query(`${COMPANY_SQL} where c.id = $1`, [v.company_id]);
      const { rows: [item] } = await c.query('select * from items where id = $1', [v.item_id]);
      await appendEvent(c, { companyId: v.company_id, itemId: v.item_id, versionId: v.id, actor: SYSTEM, type: 'virus_found',
        text: `The virus scan found malware (${r.signature}) in “${v.file_name}” (version ${v.version}). The file is blocked and cannot be opened.`,
        data: { signature: r.signature, version: v.version } });
      for (const side of ['client', 'accountant']) {
        await notify(c, { company, item, side, kind: 'virus', subject: `Blocked file: ${item.title}`, heading: 'A file was blocked by the virus scan',
          lines: [`“${v.file_name}” in ${company.name} contains malware (${r.signature}) and has been blocked.`, 'Do not open copies of it you may have downloaded. Ask the sender for a clean copy.'] });
      }
    });
  }
  return n;
}

async function autoReminders(now) {
  const s = config.scheduler;
  const { rows } = await pool.query(
    `select i.*, row_to_json(c) as company from items i join (${COMPANY_SQL}) c on c.id = i.company_id
     where i.state in ('sent','opened','expected') and i.auto_reminders < $1`, [s.maxAutoReminders]);
  let n = 0;
  for (const it of rows) {
    const since = (t) => (t ? now - new Date(t) : Infinity);
    const quiet = since(it.last_reminder_at) >= s.repeatHours * H;
    let due = false;
    let toSender = false;
    if (it.state === 'expected') {
      // report the accountant still owes: warn the accountants once, three days before the deadline
      due = it.due_at && new Date(it.due_at) - now <= 3 * 24 * H && it.auto_reminders === 0;
      toSender = true;
    } else if (it.kind === 'request') {
      due = quiet && (since(it.version_at) >= s.unopenedHours * H || (it.due_at && new Date(it.due_at) - now <= 24 * H));
    } else if (it.state === 'sent') {
      due = quiet && since(it.version_at) >= s.unopenedHours * H;
    } else if (it.state === 'opened') {
      due = quiet && since(it.opened_at) >= s.unconfirmedHours * H;
    }
    if (!due) continue;
    await tx(async (c) => {
      await lockCompany(c, it.company_id);
      const { rows: [fresh] } = await c.query('select * from items where id = $1 for update', [it.id]);
      if (fresh.state !== it.state || fresh.auto_reminders !== it.auto_reminders) return;
      const side = toSender ? 'accountant' : recipientSide(it.kind);
      const line = toSender ? `“${it.title}” is due ${fmtDay(it.due_at, tzOf(it.company.country))} and has not been sent to ${it.company.name} yet.` : reminderLine(fresh, it.company);
      await appendEvent(c, { companyId: it.company_id, itemId: it.id, actor: SYSTEM, type: 'auto_reminder',
        text: `Automatic reminder to the ${side === 'client' ? 'client' : 'accountant'}: ${line}`, data: { side, number: it.auto_reminders + 1 } });
      await notify(c, { company: it.company, item: fresh, side, kind: 'auto_reminder',
        subject: `Reminder: ${it.title}`, heading: toSender ? 'A report is due soon' : 'This is still waiting for you', lines: [line] });
      await recompute(c, it.id);
    });
    n++;
  }
  return n;
}

export function startScheduler() {
  if (!config.scheduler.enabled) return () => {};
  const tick = () => runScheduler().catch((err) => console.error('scheduler', err));
  const first = setTimeout(tick, 5000);
  const every = setInterval(tick, config.scheduler.intervalMinutes * 60e3);
  return () => { clearTimeout(first); clearInterval(every); };
}
