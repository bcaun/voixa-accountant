import express from 'express';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { HttpError, companyFor, isUuid, requireUser, sendLoginLink, logout } from '../auth.js';
import { flushEmails } from '../mailer.js';
import { storage } from '../storage.js';
import { parseUpload, discard } from '../multipart.js';
import { verifyCompany, appendEvent } from '../ledger.js';
import { parseDay } from '../dates.js';
import * as items from '../items.js';
import * as companies from '../companies.js';
import { exportCsv, exportReport } from '../export.js';

export const api = express.Router();
const json = express.json({ limit: '100kb' });
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

/* ---------- sign-in ---------- */

const attempts = new Map();
function rateLimit(key, max = 5, windowMs = 15 * 60e3) {
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  attempts.set(key, hits);
  if (hits.length > max) throw new HttpError(429, 'Too many sign-in requests. Wait a few minutes and try again.');
}

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

api.post('/auth/logout', async (req, res) => {
  await logout(req, res);
  res.json({ ok: true });
});

api.use(requireUser);

/* ---------- who am I ---------- */

api.get('/me', async (req, res) => {
  const u = req.user;
  const { rows } = u.role === 'accountant'
    ? await query('select id, no, name, nif, city from companies order by no')
    : await query(`select c.id, c.no, c.name, c.nif, c.city from companies c join memberships m on m.company_id = c.id
                   where m.user_id = $1 and m.removed_at is null order by c.no`, [u.id]);
  res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, firm: config.firmName, companies: rows });
});

/* ---------- accountant overview ---------- */

api.get('/overview', async (req, res) => {
  if (req.user.role !== 'accountant') throw new HttpError(403, 'Only accountants have an overview.');
  const { rows: cos } = await query('select id, no, name, nif, city, created_at from companies order by no');
  const { rows: open } = await query(
    `select i.id, i.company_id, i.seq, i.kind, i.title, i.category, i.period, i.due_at, i.state, i.version,
            i.sent_at, i.version_at, i.opened_at, i.done_at, i.reminders, c.no, c.name as company_name
     from items i join companies c on c.id = i.company_id where i.state <> 'done' order by i.version_at nulls last`);
  const { rows: members } = await query(
    `select m.company_id, count(*)::int as n from memberships m where m.removed_at is null group by m.company_id`);
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
    const created = await companies.createCompany(c, { user: req.user, name: str(b.name, 200), nif: str(b.nif, 40), city: str(b.city, 100) });
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
    await companies.updateCompany(c, { user: req.user, company, name: str(b.name, 200), nif: b.nif === undefined ? undefined : str(b.nif, 40), city: b.city === undefined ? undefined : str(b.city, 100) });
  });
  res.json({ ok: true });
});

api.get('/companies/:id', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  res.json(await companyState(req.user, company));
});

async function companyState(user, company) {
  const [members, obligations, its, vers, emails, evs] = await Promise.all([
    query(`select u.id, u.name, u.email, m.created_at from memberships m join users u on u.id = m.user_id
           where m.company_id = $1 and m.removed_at is null order by m.created_at`, [company.id]),
    query('select * from obligations where company_id = $1 order by active desc, created_at', [company.id]),
    query('select * from items where company_id = $1 order by seq', [company.id]),
    query(`select v.id, v.item_id, v.version, v.file_name, v.mime, v.size, v.sha256, v.uploaded_at, v.replace_reason, u.name as uploaded_by
           from versions v join items i on i.id = v.item_id left join users u on u.id = v.uploaded_by
           where i.company_id = $1 order by v.version`, [company.id]),
    query(`select item_id, to_email, kind, status, created_at, updated_at from email_messages
           where company_id = $1 and item_id is not null order by created_at`, [company.id]),
    query('select seq, at, actor_type, actor_id, actor_name, type, item_id, text, hash from events where company_id = $1 order by seq', [company.id]),
  ]);
  const byItem = (rows) => rows.reduce((m, r) => ((m[r.item_id] ||= []).push(r), m), {});
  const vMap = byItem(vers.rows), eMap = byItem(emails.rows), evMap = byItem(evs.rows.filter((e) => e.item_id));
  const { rows: evData } = await query('select item_id, type, actor_type, at, data from events where company_id = $1 and item_id is not null order by seq', [company.id]);
  const statusEvents = byItem(evData);
  return {
    company: { id: company.id, no: company.no, name: company.name, nif: company.nif, city: company.city, created_at: company.created_at },
    firm: config.firmName,
    members: members.rows,
    obligations: obligations.rows.map((o) => ({ ...o, description: companies.describeObligation(o) })),
    items: its.rows.map((i) => {
      const status = items.computeStatus(i.kind, statusEvents[i.id] || []);
      const mine = (evMap[i.id] || []).some((e) => e.actor_id === user.id && (e.type === 'opened' || e.type === 'downloaded') && status.version_at && new Date(e.at) >= new Date(status.version_at));
      return {
        id: i.id, ref: items.refOf(company, i), kind: i.kind, title: i.title, category: i.category, period: i.period, note: i.note,
        due_at: i.due_at, obligation_id: i.obligation_id, for_request: i.for_request, fulfilled_by: i.fulfilled_by, created_at: i.created_at,
        status, opened_by_me: mine, versions: vMap[i.id] || [], emails: eMap[i.id] || [],
      };
    }),
    events: evs.rows.map(({ actor_id, ...e }) => e),
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
      frequency: b.frequency, dueDay: b.dueDay, dueMonth: b.dueMonth, leadDays: b.leadDays, note: str(b.note, 1000) });
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

api.post('/companies/:id/documents', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  if (req.user.role !== 'client') throw new HttpError(403, 'Only the client side can send documents.');
  const { fields, files } = await parseUpload(req, `companies/${company.id}`);
  if (!files.length) throw new HttpError(400, 'Choose at least one file to send.');
  const requestId = isUuid(fields.requestId) ? fields.requestId : null;
  try {
    await tx(async (c) => {
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
  res.status(201).json({ sent: files.length });
});

api.post('/companies/:id/reports', async (req, res) => {
  const company = await companyFor(req.user, req.params.id);
  if (req.user.role !== 'accountant') throw new HttpError(403, 'Only accountants can send reports.');
  const { fields, files } = await parseUpload(req, `companies/${company.id}`, { maxFiles: 1 });
  try {
    if (files.length !== 1) throw new HttpError(400, 'Attach the report file.');
    const expectedItemId = isUuid(fields.itemId) ? fields.itemId : null;
    const dueAt = fields.due ? parseDay(fields.due) : null;
    if (!expectedItemId && !str(fields.title)) throw new HttpError(400, 'Give the report a title.');
    if (fields.due && !dueAt) throw new HttpError(400, 'The deadline is not a valid date.');
    await tx((c) => items.createReport(c, { user: req.user, company, file: files[0], title: str(fields.title, 200),
      category: str(fields.category, 60) || 'Other', dueAt, note: str(fields.note, 1000), expectedItemId }));
  } catch (err) {
    await discard(files);
    throw err;
  }
  flushEmails().catch((err) => console.error('mail', err));
  res.status(201).json({ ok: true });
});

api.post('/companies/:id/requests', json, async (req, res) => {
  const b = req.body || {};
  const dueAt = parseDay(b.due);
  if (!str(b.title)) throw new HttpError(400, 'Describe the document you need.');
  if (!dueAt) throw new HttpError(400, 'Set a due date.');
  await tx(async (c) => {
    const company = await companyFor(req.user, req.params.id, c);
    await items.createRequest(c, { user: req.user, company, title: str(b.title, 200), dueAt, note: str(b.note, 1000) });
  });
  flushEmails().catch((err) => console.error('mail', err));
  res.status(201).json({ ok: true });
});

/* ---------- one item ---------- */

async function itemFor(user, id, c) {
  if (!isUuid(id)) throw new HttpError(404, 'Item not found.');
  const item = await items.loadItem(c || { query }, id, { lock: !!c });
  const company = await companyFor(user, item.company_id, c);
  return { item, company };
}

api.post('/items/:id/versions', async (req, res) => {
  const { company } = await itemFor(req.user, req.params.id);
  const { fields, files } = await parseUpload(req, `companies/${company.id}`, { maxFiles: 1 });
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
