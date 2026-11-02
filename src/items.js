// Everything that happens to a document, report or request. Each operation runs
// inside the caller's transaction, writes its evidence events, refreshes the
// item's cached status and queues the notification emails.
import { firmLogoUrl } from './billing.js';
import { config } from './config.js';
import { appendEvent } from './ledger.js';
import { queueEmail, renderEmail } from './mailer.js';
import { HttpError, actorOf } from './auth.js';
import { fmtDay as fmtDayTz, fmtTime as fmtTimeTz } from './dates.js';
import { tzOf } from './countries.js';
import { translator, langFor, dayIn, timeIn } from './i18n.js';
import { enqueueRecognition } from './recognition/recognize.js';

export const SYSTEM = { type: 'system', id: null, name: 'Pescada' };
export const recipientSide = (kind) => (kind === 'doc' ? 'accountant' : 'client');
export const senderSide = (kind) => (kind === 'doc' ? 'client' : 'accountant');
export const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
export const refOf = (company, item) => `PX-${String(company.no).padStart(3, '0')}-${String(item.seq).padStart(4, '0')}`;
// dates are shown in the client's country time
const fmtDay = (d, company) => fmtDayTz(d, tzOf(company?.country));
const fmtTime = (d, company) => fmtTimeTz(d, tzOf(company?.country));

/** Derive an item's status from its events (oldest first). */
export function computeStatus(kind, events) {
  const rec = recipientSide(kind);
  const s = {
    state: 'expected', version: 0, sent_at: null, version_at: null, notified_at: null, email_delivered_at: null,
    email_problem: null, opened_at: null, done_at: null, reminders: 0, auto_reminders: 0, last_reminder_at: null,
    changes_requested_at: null,
  };
  for (const e of events) {
    switch (e.type) {
      case 'uploaded': case 'replaced': case 'requested':
        s.sent_at ??= e.at;
        s.version_at = e.at;
        if (e.type !== 'requested') s.version = e.data?.version ?? s.version + 1;
        Object.assign(s, { opened_at: null, done_at: null, notified_at: null, email_delivered_at: null, email_problem: null, auto_reminders: 0, changes_requested_at: null });
        break;
      case 'email_sent': if (s.version_at && !s.notified_at) s.notified_at = e.at; break;
      case 'email_delivered': if (s.version_at && !s.email_delivered_at) s.email_delivered_at = e.at; break;
      case 'email_bounced': case 'email_spam': case 'email_failed': if (s.version_at) s.email_problem = e.type; break;
      case 'opened': case 'downloaded': if (e.actor_type === rec && s.version_at && !s.opened_at) s.opened_at = e.at; break;
      case 'confirmed': case 'fulfilled': if (s.version_at) s.done_at = e.at; break;
      case 'changes_requested': s.changes_requested_at = e.at; break;
      case 'reminder': s.reminders++; s.last_reminder_at = e.at; break;
      case 'auto_reminder': s.reminders++; s.auto_reminders++; s.last_reminder_at = e.at; break;
    }
  }
  s.state = !s.version_at ? 'expected' : s.done_at ? 'done' : s.opened_at ? 'opened' : 'sent';
  return s;
}

export async function recompute(c, itemId) {
  const { rows: [it] } = await c.query('select kind from items where id = $1', [itemId]);
  const { rows: evs } = await c.query('select type, actor_type, at, data from events where item_id = $1 order by seq', [itemId]);
  const s = computeStatus(it.kind, evs);
  await c.query(
    `update items set state=$2, version=$3, sent_at=$4, version_at=$5, opened_at=$6, done_at=$7,
       reminders=$8, auto_reminders=$9, last_reminder_at=$10 where id=$1`,
    [itemId, s.state, s.version, s.sent_at, s.version_at, s.opened_at, s.done_at, s.reminders, s.auto_reminders, s.last_reminder_at]);
  return s;
}

/** People on one side of a company's workspace who should hear about it. */
export async function sideUsers(c, companyId, side) {
  if (side === 'accountant') {
    // the accountants of the firm the client belongs to, and no one else
    return (await c.query(
      `select u.id, u.email, u.name, u.role, u.notify_mode, u.lang from users u join companies co on co.firm_id = u.firm_id
       where co.id = $1 and u.role = 'accountant' and u.disabled_at is null and accountant_sees(co.id, u.id)`, [companyId])).rows;
  }
  return (await c.query(
    `select u.id, u.email, u.name, u.role, u.notify_mode, u.lang from memberships m join users u on u.id = m.user_id
     where m.company_id = $1 and m.removed_at is null and u.disabled_at is null`, [companyId])).rows;
}

// These always go out at once, even to people who chose the daily digest.
export const URGENT = new Set(['changes', 'auto_reminder', 'reminder', 'email_problem', 'virus']);
export const notifyModeOf = (u) => u.notify_mode || (u.role === 'accountant' ? 'digest' : 'instant');

/**
 * Email (or queue for the digest) one side of a workspace. `msg(t, f)` writes the message in each
 * recipient's language: `t` translates, `f.day` and `f.time` format dates for them.
 */
export async function notify(c, { company, item, side, kind, msg, exceptUserId }) {
  const url = `${config.appUrl}/#/c/${company.id}${item ? `/i/${item.id}` : ''}`;
  const tz = tzOf(company.country);
  for (const u of await sideUsers(c, company.id, side)) {
    if (u.id === exceptUserId) continue;
    const lang = langFor(u, u.role === 'accountant' ? company.firm_country : company.country);
    const t = translator(lang);
    const { subject, heading, lines } = msg(t, { day: (d) => dayIn(d, tz, lang), time: (d) => timeIn(d, tz, lang), lang });
    if (notifyModeOf(u) === 'digest' && !URGENT.has(kind)) {
      // collected for the daily digest; the item shows as notified when the digest is sent
      await c.query('insert into digest_entries (user_id, company_id, item_id, kind, subject, line) values ($1,$2,$3,$4,$5,$6)',
        [u.id, company.id, item?.id ?? null, kind, subject, lines[0] || heading]);
      continue;
    }
    const logoUrl = u.role === 'client' ? firmLogoUrl(company) : null;
    const { html, text } = renderEmail({ heading, lines, button: { label: item ? t('Open in Pescada') : t('Open the workspace'), url }, logo: logoUrl && { url: logoUrl, alt: company.firm_name },
      footer: t('{firm} · Pescada. This message and every action on the document are recorded in the workspace log.', { firm: company.firm_name }) });
    await queueEmail(c, { companyId: company.id, itemId: item?.id, toUserId: u.id, toEmail: u.email, kind, subject, html, text });
  }
}

async function nextSeq(c, companyId) {
  const { rows: [r] } = await c.query('update companies set item_seq = item_seq + 1 where id = $1 returning item_seq', [companyId]);
  return r.item_seq;
}

async function insertItem(c, f) {
  const seq = await nextSeq(c, f.company_id);
  const { rows: [it] } = await c.query(
    `insert into items (company_id, seq, kind, title, category, period, note, due_at, obligation_id, for_request, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [f.company_id, seq, f.kind, f.title, f.category || 'Other', f.period || '', f.note || '', f.due_at || null,
      f.obligation_id || null, f.for_request || null, f.created_by || null]);
  return it;
}

async function insertVersion(c, item, file, user, reason = '') {
  const { rows: [v] } = await c.query(
    `insert into versions (item_id, version, storage_key, file_name, mime, size, sha256, uploaded_by, replace_reason, scan_status, scan_signature, scanned_at)
     values ($1, coalesce((select max(version) from versions where item_id = $1), 0) + 1, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [item.id, file.key, file.name, file.mime, file.size, file.sha256, user?.id ?? null, reason,
      file.scan?.status || 'off', file.scan?.signature || null, ['clean', 'infected'].includes(file.scan?.status) ? new Date() : null]);
  return v;
}

function assertSide(user, side, what) {
  if (user.role !== side) throw new HttpError(403, `Only the ${side === 'client' ? 'client' : 'accountant'} side can ${what}.`);
}

export async function loadItem(c, itemId, { lock = false } = {}) {
  const { rows: [it] } = await c.query(`select * from items where id = $1${lock ? ' for update' : ''}`, [itemId]);
  if (!it) throw new HttpError(404, 'Item not found.');
  return it;
}

const cleanTitle = (name) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name;

/* ---------- client → accountant ---------- */

export async function createDocument(c, { user, company, file, category, period, note, requestId }) {
  assertSide(user, 'client', 'send documents');
  let request = null;
  if (requestId) {
    request = await loadItem(c, requestId, { lock: true });
    if (request.company_id !== company.id || request.kind !== 'request') throw new HttpError(400, 'That request belongs to another workspace.');
  }
  const it = await insertItem(c, { company_id: company.id, kind: 'doc', title: cleanTitle(file.name), category, period, note, for_request: request?.id, created_by: user.id });
  const v = await insertVersion(c, it, file, user);
  await enqueueRecognition(c, it, v);
  await appendEvent(c, { companyId: company.id, itemId: it.id, versionId: v.id, actor: actorOf(user), type: 'uploaded',
    text: `${actorOf(user).name} uploaded “${file.name}” (${fmtSize(file.size)})`,
    data: { version: 1, file: file.name, size: file.size, sha256: file.sha256 } });
  if (note) await appendEvent(c, { companyId: company.id, itemId: it.id, actor: actorOf(user), type: 'comment', text: `${actorOf(user).name}: “${note}”`, data: { message: note } });
  if (request && request.state !== 'done') {
    await appendEvent(c, { companyId: company.id, itemId: request.id, actor: actorOf(user), type: 'fulfilled',
      text: `${actorOf(user).name} fulfilled the request with “${file.name}”`, data: { by_item: it.id } });
    await c.query('update items set fulfilled_by = $2 where id = $1', [request.id, it.id]);
    await recompute(c, request.id);
  }
  await notify(c, { company, item: it, side: 'accountant', kind: 'new_document',
    msg: (t) => ({
      subject: t('New document from {company}: {title}', { company: company.name, title: it.title }),
      heading: t('{company} sent you a document', { company: company.name }),
      lines: [request ? t('{who} uploaded “{file}” ({size}) in response to “{request}”.', { who: actorOf(user).name, file: file.name, size: fmtSize(file.size), request: request.title })
        : t('{who} uploaded “{file}” ({size}).', { who: actorOf(user).name, file: file.name, size: fmtSize(file.size) }),
      note ? t('Note: {note}', { note }) : t('Open it in Pescada and confirm receipt.')] }) });
  await recompute(c, it.id);
  return it;
}

/* ---------- accountant → client ---------- */

export async function createReport(c, { user, company, file, title, category, dueAt, note, expectedItemId }) {
  assertSide(user, 'accountant', 'send reports');
  let it;
  if (expectedItemId) {
    it = await loadItem(c, expectedItemId, { lock: true });
    if (it.company_id !== company.id || it.kind !== 'report' || it.version > 0) throw new HttpError(400, 'This report already has a file. Use “Replace file” instead.');
  } else {
    it = await insertItem(c, { company_id: company.id, kind: 'report', title, category, note, due_at: dueAt, created_by: user.id });
  }
  const v = await insertVersion(c, it, file, user);
  const late = it.due_at && new Date() > it.due_at;
  await appendEvent(c, { companyId: company.id, itemId: it.id, versionId: v.id, actor: actorOf(user), type: 'uploaded',
    text: `${actorOf(user).name} sent the report “${file.name}” (${fmtSize(file.size)})${it.due_at ? `, deadline ${fmtDay(it.due_at, company)}${late ? ' (sent late)' : ''}` : ''}`,
    data: { version: 1, file: file.name, size: file.size, sha256: file.sha256, due_at: it.due_at, late: !!late } });
  if (note) await appendEvent(c, { companyId: company.id, itemId: it.id, actor: actorOf(user), type: 'comment', text: `${actorOf(user).name}: “${note}”`, data: { message: note } });
  await notify(c, { company, item: it, side: 'client', kind: 'new_report',
    msg: (t, f) => ({
      subject: `${company.firm_name}: ${it.title}`,
      heading: t('New report: {title}', { title: it.title }),
      lines: [t('{who} at {firm} sent you “{file}”.', { who: actorOf(user).name, firm: company.firm_name, file: file.name }),
        it.due_at ? t('Deadline: {date}. Please open it and approve it, or ask for changes.', { date: f.day(it.due_at) }) : t('Please open it and approve it, or ask for changes.'),
        ...(note ? [t('Message: {note}', { note })] : [])] }) });
  await recompute(c, it.id);
  return it;
}

export async function createRequest(c, { user, company, title, dueAt, note, category, period, obligationId }) {
  if (user) assertSide(user, 'accountant', 'request documents');
  const actor = user ? actorOf(user) : SYSTEM;
  const it = await insertItem(c, { company_id: company.id, kind: 'request', title, category: category || 'Request', period, note, due_at: dueAt, obligation_id: obligationId, created_by: user?.id });
  await appendEvent(c, { companyId: company.id, itemId: it.id, actor, type: 'requested',
    text: `${actor.name} requested “${title}”, due ${fmtDay(dueAt, company)}${obligationId ? ' (recurring)' : ''}`, data: { due_at: dueAt, obligation_id: obligationId ?? null } });
  await notify(c, { company, item: it, side: 'client', kind: 'request',
    msg: (t, f) => ({
      subject: t('Document needed by {date}: {title}', { date: f.day(dueAt), title }),
      heading: t('{firm} needs a document', { firm: company.firm_name }),
      lines: [t('Please upload: {title}.', { title }), t('Due: {date}.', { date: f.day(dueAt) }), ...(note ? [note] : [])] }) });
  await recompute(c, it.id);
  return it;
}

export async function createExpectedReport(c, { company, title, category, period, dueAt, obligationId }) {
  const it = await insertItem(c, { company_id: company.id, kind: 'report', title, category, period, due_at: dueAt, obligation_id: obligationId });
  await appendEvent(c, { companyId: company.id, itemId: it.id, actor: SYSTEM, type: 'expected',
    text: `Report “${title}” is due from ${company.firm_name} by ${fmtDay(dueAt, company)}`, data: { due_at: dueAt, obligation_id: obligationId } });
  await recompute(c, it.id);
  return it;
}

/* ---------- actions on an existing item ---------- */

export async function replaceVersion(c, { user, company, item, file, reason }) {
  assertSide(user, senderSide(item.kind), 'replace this file');
  if (item.kind === 'request' || item.version === 0) throw new HttpError(400, 'There is no file to replace yet.');
  if (!reason) throw new HttpError(400, 'Say why the file is being replaced. The reason is kept in the log.');
  const { rows: [prev] } = await c.query('select * from versions where item_id = $1 order by version desc limit 1', [item.id]);
  const v = await insertVersion(c, item, file, user, reason);
  if (item.kind === 'doc') await enqueueRecognition(c, item, v);
  await appendEvent(c, { companyId: company.id, itemId: item.id, versionId: v.id, actor: actorOf(user), type: 'replaced',
    text: `${actorOf(user).name} replaced version ${prev.version} with “${file.name}” (${fmtSize(file.size)}). Reason: ${reason}`,
    data: { version: v.version, file: file.name, size: file.size, sha256: file.sha256, previous_version: prev.version, previous_sha256: prev.sha256, reason } });
  const side = recipientSide(item.kind);
  await notify(c, { company, item, side, kind: 'replaced',
    msg: (t) => ({
      subject: t('Updated file: {title}', { title: item.title }),
      heading: t('A new version of “{title}” was sent', { title: item.title }),
      lines: [t('{who} replaced version {old} with version {new} (“{file}”).', { who: actorOf(user).name, old: prev.version, new: v.version, file: file.name }),
        t('Reason: {reason}', { reason }),
        item.kind === 'doc' ? t('The earlier version is kept. Please open the new one and confirm receipt again.') : t('The earlier version is kept. Please open the new one and approve it again.')] }) });
  return recompute(c, item.id);
}

export async function logOpen(c, { user, company, item, version, download }) {
  await appendEvent(c, { companyId: company.id, itemId: item.id, versionId: version.id, actor: actorOf(user), type: download ? 'downloaded' : 'opened',
    text: `${actorOf(user).name} ${download ? 'downloaded' : 'opened'} “${version.file_name}” (version ${version.version})`,
    data: { version: version.version, sha256: version.sha256 } });
  return recompute(c, item.id);
}

export async function markSeen(c, { user, company, item }) {
  if (item.kind !== 'request' || user.role !== 'client') return;
  const { rows } = await c.query(`select 1 from events where item_id = $1 and type = 'opened' and actor_id = $2 limit 1`, [item.id, user.id]);
  if (rows.length) return;
  await appendEvent(c, { companyId: company.id, itemId: item.id, actor: actorOf(user), type: 'opened', text: `${actorOf(user).name} viewed the request` });
  await recompute(c, item.id);
}

export async function confirm(c, { user, company, item }) {
  assertSide(user, recipientSide(item.kind), item.kind === 'report' ? 'approve reports' : 'confirm receipt');
  if (item.kind === 'request') throw new HttpError(400, 'A request is fulfilled by uploading the document.');
  if (item.state === 'done') throw new HttpError(409, 'This is already confirmed.');
  const { rows } = await c.query(
    `select 1 from events where item_id = $1 and actor_id = $2 and type in ('opened','downloaded') and at >= $3 limit 1`,
    [item.id, user.id, item.version_at]);
  if (!rows.length) throw new HttpError(409, 'Open the current version of the document first. It can only be confirmed after you have opened it.');
  await appendEvent(c, { companyId: company.id, itemId: item.id, actor: actorOf(user), type: 'confirmed',
    text: `${actorOf(user).name} ${item.kind === 'report' ? 'approved the report' : 'confirmed receipt'} (version ${item.version})`, data: { version: item.version } });
  await notify(c, { company, item, side: senderSide(item.kind), kind: 'confirmed',
    msg: (t, f) => ({
      subject: item.kind === 'report' ? t('Approved: {title}', { title: item.title }) : t('Received: {title}', { title: item.title }),
      heading: item.kind === 'report' ? t('{who} approved “{title}”', { who: actorOf(user).name, title: item.title }) : t('{who} confirmed receipt of “{title}”', { who: actorOf(user).name, title: item.title }),
      lines: [item.kind === 'report' ? t('Version {v} was approved on {time}.', { v: item.version, time: f.time(new Date()) }) : t('Version {v} was confirmed as received on {time}.', { v: item.version, time: f.time(new Date()) }),
        t('This is recorded in the workspace log.')] }) });
  return recompute(c, item.id);
}

export async function requestChanges(c, { user, company, item, message }) {
  assertSide(user, 'client', 'ask for changes to a report');
  if (item.kind !== 'report') throw new HttpError(400, 'Changes can only be requested on reports.');
  if (!message) throw new HttpError(400, 'Write what should change.');
  await appendEvent(c, { companyId: company.id, itemId: item.id, actor: actorOf(user), type: 'changes_requested',
    text: `${actorOf(user).name} asked for changes: “${message}”`, data: { message } });
  await notify(c, { company, item, side: 'accountant', kind: 'changes',
    msg: (t) => ({ subject: t('Changes requested: {title}', { title: item.title }), heading: t('{company} asked for changes', { company: company.name }),
      lines: [`“${message}”`, t('Report: {title}', { title: item.title })] }) });
  return recompute(c, item.id);
}

export async function comment(c, { user, company, item, message }) {
  if (!message) throw new HttpError(400, 'Write a note first.');
  await appendEvent(c, { companyId: company.id, itemId: item.id, actor: actorOf(user), type: 'comment',
    text: `${actorOf(user).name}: “${message}”`, data: { message } });
  await notify(c, { company, item, side: user.role === 'client' ? 'accountant' : 'client', kind: 'comment',
    msg: (t) => ({ subject: t('New note on {title}', { title: item.title }), heading: t('{who} added a note', { who: actorOf(user).name }),
      lines: [`“${message}”`, t('On: {title}', { title: item.title })] }) });
  return recompute(c, item.id);
}

export async function remind(c, { user, company, item }) {
  assertSide(user, senderSide(item.kind), 'send a reminder');
  if (item.state === 'done' || item.state === 'expected') throw new HttpError(409, 'There is nothing to remind about.');
  const side = recipientSide(item.kind);
  await appendEvent(c, { companyId: company.id, itemId: item.id, actor: actorOf(user), type: 'reminder',
    text: `${actorOf(user).name} sent a reminder`, data: {} });
  await notify(c, { company, item, side, kind: 'reminder',
    msg: (t, f) => ({ subject: t('Reminder: {title}', { title: item.title }), heading: t('Reminder from {who}', { who: actorOf(user).name }),
      lines: [reminderLine(item, company, t, f)] }) });
  return recompute(c, item.id);
}

/** The reminder sentence; in English for the log, or in a recipient's language with `t` and `f`. */
export function reminderLine(item, company, t = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => v?.[k] ?? m), f = { day: (d) => fmtDay(d, company) }) {
  if (item.kind === 'request') return item.due_at ? t('“{title}” is due {date} and has not been uploaded yet.', { title: item.title, date: f.day(item.due_at) }) : t('“{title}” is due soon and has not been uploaded yet.', { title: item.title });
  if (item.state === 'opened') return item.kind === 'doc' ? t('“{title}” was opened but not yet confirmed as received.', { title: item.title }) : t('“{title}” was opened but not yet approved.', { title: item.title });
  return t('“{title}” is waiting for you and has not been opened yet.', { title: item.title });
}
