// Closing a client at the end of a contract, as the data processing agreement promises:
//   close   → the client's people lose access at once; the firm can still read and export
//             everything for CLOSE_EXPORT_DAYS (30) and can reopen it in that time;
//   block   → after that the workspace disappears for everyone; data is kept only for legal duties;
//   purge   → once RETENTION_YEARS (6) have passed since its newest file, files, log and all
//             other records are deleted. Only a one-line note stays in the firm's own log.
import { config } from './config.js';
import { pool, query, tx } from './db.js';
import { appendEvent, lockCompany } from './ledger.js';
import { storage } from './storage.js';
import { HttpError, actorOf } from './auth.js';
import { firmEvent } from './audit.js';
import { notify, refOf, SYSTEM } from './items.js';
import { exportCsv, exportReport } from './export.js';
import { makeZip } from './zip.js';
import { fmtDay } from './dates.js';
import { tzOf } from './countries.js';

const DAY = 864e5;

export async function closeCompany(c, { user, company, reason }) {
  if (user.firm_role !== 'admin') throw new HttpError(403, 'Only the firm’s administrators can close a client.');
  if (company.closed_at) throw new HttpError(409, 'This client is already closed.');
  const now = new Date();
  const exportUntil = new Date(now.getTime() + config.closeExportDays * DAY);
  const { rows: [last] } = await c.query(
    `select max(v.uploaded_at) as at from versions v join items i on i.id = v.item_id where i.company_id = $1`, [company.id]);
  const keepFrom = last.at ? new Date(last.at) : now;
  const purgeAfter = new Date(Math.max(exportUntil.getTime(), keepFrom.getTime() + config.retentionYears * 365.25 * DAY));
  // tell the client's people before their access ends
  await notify(c, { company, item: null, side: 'client', kind: 'closed', msg: (t, f) => ({
    subject: t('{firm} has closed the {company} workspace', { firm: company.firm_name, company: company.name }),
    heading: t('This workspace has been closed'), lines: [
      t('{firm} has closed the {company} workspace on Pescada. You can no longer sign in to it.', { firm: company.firm_name, company: company.name }),
      t('If you need copies of your documents or of the activity log, ask your accountant: they can export everything until {date}.', { date: f.day(exportUntil) })] }) });
  await c.query('update companies set closed_at = $2, closed_by = $3, export_until = $4, purge_after = $5 where id = $1',
    [company.id, now, user.id, exportUntil, purgeAfter]);
  await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'workspace_closed',
    text: `${actorOf(user).name} closed the workspace${reason ? ` (${reason})` : ''}. The client’s access ended. The firm can export until ${fmtDay(exportUntil, tzOf(company.country))}; the data is then blocked and deleted after ${fmtDay(purgeAfter, tzOf(company.country))}.`,
    data: { reason: reason || '', export_until: exportUntil, purge_after: purgeAfter } });
  await firmEvent(c, company.firm_id, user, 'client_closed', `${actorOf(user).name} closed client #${company.no} ${company.name}`);
}

export async function reopenCompany(c, { user, company }) {
  if (user.firm_role !== 'admin') throw new HttpError(403, 'Only the firm’s administrators can reopen a client.');
  if (!company.closed_at) throw new HttpError(409, 'This client is not closed.');
  if (company.blocked_at || new Date(company.export_until) < new Date()) throw new HttpError(409, 'The export period is over; the workspace can no longer be reopened.');
  await c.query('update companies set closed_at = null, closed_by = null, export_until = null, purge_after = null where id = $1', [company.id]);
  await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'workspace_reopened', text: `${actorOf(user).name} reopened the workspace. The client’s people can sign in again.` });
  await firmEvent(c, company.firm_id, user, 'client_reopened', `${actorOf(user).name} reopened client #${company.no} ${company.name}`);
}

async function readAll(stream) { const chunks = []; for await (const ch of stream) chunks.push(ch); return Buffer.concat(chunks); }

/** Everything about one client in one ZIP: every version of every file, the log as CSV and the printable report. */
export async function exportEverything(company, by) {
  const { rows } = await query(
    `select i.seq, i.title, v.version, v.file_name, v.storage_key, v.size, v.sha256, v.scan_status
     from items i join versions v on v.item_id = i.id where i.company_id = $1 order by i.seq, v.version`, [company.id]);
  const total = rows.reduce((a, r) => a + Number(r.size), 0);
  if (total > 900 * 1048576) throw new HttpError(413, 'This workspace holds more than 900 MB of files. Ask support for a full export.');
  const entries = [];
  for (const r of rows) {
    if (r.scan_status === 'infected') continue;
    entries.push({ name: `files/${refOf(company, r)} v${r.version} ${r.file_name}`, data: await readAll(await storage.get(r.storage_key)) });
  }
  const csv = await exportCsv(company);
  entries.push({ name: 'activity-log.csv', data: Buffer.from(csv.body) });
  entries.push({ name: 'tracking-report.html', data: Buffer.from(await exportReport(company, { by })) });
  entries.push({ name: 'files.csv', data: Buffer.from(['ref,version,file,sha256', ...rows.map((r) => [refOf(company, r), r.version, r.file_name, r.sha256].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\r\n')) });
  return makeZip(entries);
}

/** Scheduler: block closed clients whose export window ended, and purge blocked ones whose retention is over. */
export async function runClosures(now = new Date()) {
  const { rows: toBlock } = await pool.query('select id, firm_id, no, name from companies where closed_at is not null and blocked_at is null and export_until <= $1', [now]);
  for (const co of toBlock) {
    await tx(async (c) => {
      await lockCompany(c, co.id);
      await c.query('update companies set blocked_at = $2 where id = $1', [co.id, now]);
      await appendEvent(c, { companyId: co.id, actor: SYSTEM, type: 'workspace_blocked', text: 'The export period ended. The workspace is blocked: kept only to meet legal duties and visible to no one.' });
      await firmEvent(c, co.firm_id, null, 'client_blocked', `Client #${co.no} ${co.name} is now blocked (export period over)`);
    });
  }
  const { rows: toPurge } = await pool.query('select * from companies where blocked_at is not null and purge_after <= $1', [now]);
  let purged = 0;
  for (const co of toPurge) {
    try { await purge(co); purged++; } catch (err) { console.error('purge', co.id, err.message); }
  }
  return { blocked: toBlock.length, purged };
}

async function purge(co) {
  const { rows: files } = await pool.query('select v.storage_key from versions v join items i on i.id = v.item_id where i.company_id = $1', [co.id]);
  // files first: if storage refuses (a retention lock still running), nothing else is deleted and it is tried again later
  for (const f of files) await storage.remove(f.storage_key);
  await tx(async (c) => {
    await c.query("select set_config('pescada.purge', $1, true)", [co.id]);
    const its = 'select id from items where company_id = $1';
    await c.query(`delete from payment_matches where company_id = $1`, [co.id]);
    await c.query(`delete from bank_transactions where company_id = $1`, [co.id]);
    await c.query(`delete from invoice_data where company_id = $1`, [co.id]);
    await c.query(`delete from extractions where company_id = $1`, [co.id]);
    await c.query(`delete from jobs where item_id in (${its})`, [co.id]);
    await c.query(`delete from ai_usage where company_id = $1`, [co.id]);
    await c.query(`delete from digest_entries where company_id = $1`, [co.id]);
    await c.query(`delete from email_items where company_id = $1`, [co.id]);
    await c.query(`delete from email_messages where company_id = $1 or item_id in (${its})`, [co.id]);
    await c.query(`delete from events where company_id = $1`, [co.id]);
    await c.query(`delete from versions where item_id in (${its})`, [co.id]);
    await c.query(`update items set for_request = null, fulfilled_by = null where company_id = $1`, [co.id]);
    await c.query(`delete from items where company_id = $1`, [co.id]);
    await c.query(`delete from obligations where company_id = $1`, [co.id]);
    await c.query(`delete from company_assignments where company_id = $1`, [co.id]);
    const { rows: people } = await c.query('delete from memberships where company_id = $1 returning user_id', [co.id]);
    await c.query('delete from companies where id = $1', [co.id]);
    // the client's people who are in no other workspace are deleted too, where nothing else refers to them
    for (const { user_id } of people) {
      await c.query('savepoint u');
      try {
        const { rows } = await c.query(`select 1 from memberships where user_id = $1 limit 1`, [user_id]);
        if (!rows.length) {
          await c.query('delete from sessions where user_id = $1', [user_id]);
          await c.query('delete from login_tokens where user_id = $1', [user_id]);
          await c.query(`delete from users where id = $1 and role = 'client'`, [user_id]);
        }
        await c.query('release savepoint u');
      } catch { await c.query('rollback to savepoint u'); }
    }
    await firmEvent(c, co.firm_id, null, 'client_purged', `All data of former client #${co.no} was deleted at the end of its retention period`);
  });
}
