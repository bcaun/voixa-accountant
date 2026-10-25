// Background work: automatic reminders and recurring deadlines. Runs inside
// the web process on a timer; a Postgres advisory lock keeps two servers from
// running it at the same time.
import { config } from './config.js';
import { pool, tx } from './db.js';
import { appendEvent } from './ledger.js';
import { flushEmails } from './mailer.js';
import { generateDue } from './companies.js';
import { SYSTEM, notify, recipientSide, recompute, reminderLine } from './items.js';
import { fmtDay } from './dates.js';
import { processJobs } from './recognition/recognize.js';

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
      await flushEmails();
      return { generated, reminded };
    } finally {
      await lockClient.query('select pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    lockClient.release();
  }
}

async function generateObligations(now) {
  const { rows } = await pool.query('select o.*, row_to_json(c) as company from obligations o join companies c on c.id = o.company_id where o.active');
  let n = 0;
  for (const o of rows) {
    const made = await tx((c) => generateDue(c, o, o.company, now));
    if (made) n++;
  }
  return n;
}

const H = 36e5;

async function autoReminders(now) {
  const s = config.scheduler;
  const { rows } = await pool.query(
    `select i.*, row_to_json(c) as company from items i join companies c on c.id = i.company_id
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
      const { rows: [fresh] } = await c.query('select * from items where id = $1 for update', [it.id]);
      if (fresh.state !== it.state || fresh.auto_reminders !== it.auto_reminders) return;
      const side = toSender ? 'accountant' : recipientSide(it.kind);
      const line = toSender ? `“${it.title}” is due ${fmtDay(it.due_at)} and has not been sent to ${it.company.name} yet.` : reminderLine(fresh);
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
