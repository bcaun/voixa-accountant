// Client workspaces, the people in them, and recurring obligations.
import { appendEvent } from './ledger.js';
import { HttpError, actorOf, sendLoginLink } from './auth.js';
import { dueAfter, fmtDay } from './dates.js';
import { createExpectedReport, createRequest } from './items.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createCompany(c, { user, name, nif, city }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can add clients.');
  if (!name) throw new HttpError(400, 'Enter the company name.');
  const { rows: [co] } = await c.query(
    'insert into companies (name, nif, city, created_by) values ($1,$2,$3,$4) returning *', [name, nif || '', city || '', user.id]);
  await appendEvent(c, { companyId: co.id, actor: actorOf(user), type: 'company_created',
    text: `${actorOf(user).name} created the workspace for ${name}${nif ? ` (NIF ${nif})` : ''}`, data: { name, nif: nif || '', city: city || '' } });
  return co;
}

export async function updateCompany(c, { user, company, name, nif, city }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can change client details.');
  const next = { name: name || company.name, nif: nif ?? company.nif, city: city ?? company.city };
  await c.query('update companies set name=$2, nif=$3, city=$4 where id=$1', [company.id, next.name, next.nif, next.city]);
  await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'company_updated',
    text: `${actorOf(user).name} updated the company details: ${next.name}, NIF ${next.nif || '—'}, ${next.city || '—'}`, data: next });
}

/** Give a person access to a company workspace, creating their account if needed, and email them a sign-in link. */
export async function addMember(c, { user, company, email, name }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  let { rows: [u] } = await c.query('select * from users where email = $1', [email]);
  if (u && u.role === 'accountant') throw new HttpError(400, 'That address belongs to an accountant. Accountants already see every workspace.');
  if (!u) {
    ({ rows: [u] } = await c.query(`insert into users (email, name, role) values ($1, $2, 'client') returning *`, [email, name]));
  } else if (!u.name && name) {
    await c.query('update users set name = $2 where id = $1', [u.id, name]);
    u.name = name;
  }
  const { rows: [m] } = await c.query('select * from memberships where company_id = $1 and user_id = $2', [company.id, u.id]);
  if (m && !m.removed_at) throw new HttpError(409, `${email} already has access.`);
  if (m) await c.query('update memberships set removed_at = null, added_by = $3, created_at = now() where company_id = $1 and user_id = $2', [company.id, u.id, user.id]);
  else await c.query('insert into memberships (company_id, user_id, added_by) values ($1,$2,$3)', [company.id, u.id, user.id]);
  await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'member_added',
    text: `${actorOf(user).name} gave ${u.name || email} (${email}) access to the workspace`, data: { user_id: u.id, email } });
  await sendLoginLink(c, u, { invitedBy: actorOf(user).name, companyName: company.name, companyId: company.id });
  return u;
}

export async function removeMember(c, { user, company, userId }) {
  const { rows: [m] } = await c.query(
    `select u.* from memberships m join users u on u.id = m.user_id where m.company_id = $1 and m.user_id = $2 and m.removed_at is null`,
    [company.id, userId]);
  if (!m) throw new HttpError(404, 'That person does not have access.');
  await c.query('update memberships set removed_at = now() where company_id = $1 and user_id = $2', [company.id, userId]);
  await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'member_removed',
    text: `${actorOf(user).name} removed ${m.name || m.email} (${m.email}) from the workspace`, data: { user_id: m.id, email: m.email } });
}

const FREQ = { monthly: 'every month', quarterly: 'every quarter (Jan, Apr, Jul, Oct)', yearly: 'every year' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const describeObligation = (o) =>
  `${o.kind === 'request' ? 'Client uploads' : 'Accountant sends'} “${o.title}” ${FREQ[o.frequency]}, due day ${o.due_day}${o.frequency === 'yearly' ? ` of ${MONTHS[(o.due_month || 1) - 1]}` : ''}`;

export async function createObligation(c, { user, company, kind, title, category, frequency, dueDay, dueMonth, leadDays, note }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can set up recurring deadlines.');
  if (!['request', 'report'].includes(kind)) throw new HttpError(400, 'Choose who delivers: the client or the accountant.');
  if (!['monthly', 'quarterly', 'yearly'].includes(frequency)) throw new HttpError(400, 'Choose how often.');
  if (!title) throw new HttpError(400, 'Enter a title.');
  const day = Number(dueDay);
  if (!(day >= 1 && day <= 31)) throw new HttpError(400, 'The due day must be between 1 and 31.');
  const month = frequency === 'yearly' ? Number(dueMonth) : null;
  if (frequency === 'yearly' && !(month >= 1 && month <= 12)) throw new HttpError(400, 'Choose the month for a yearly deadline.');
  const lead = Math.min(60, Math.max(0, Number(leadDays ?? 7) || 0));
  const { rows: [o] } = await c.query(
    `insert into obligations (company_id, kind, title, category, frequency, due_day, due_month, lead_days, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [company.id, kind, title, category || (kind === 'request' ? 'Other' : 'Tax return'), frequency, day, month, lead, note || '', user.id]);
  await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'obligation_created',
    text: `${actorOf(user).name} set up a recurring deadline: ${describeObligation(o)}, opened ${lead} days ahead`, data: { obligation_id: o.id } });
  await generateDue(c, o, company);
  return o;
}

export async function stopObligation(c, { user, company, obligationId }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can change recurring deadlines.');
  const { rows: [o] } = await c.query('update obligations set active = false where id = $1 and company_id = $2 and active returning *', [obligationId, company.id]);
  if (!o) throw new HttpError(404, 'That recurring deadline is not active.');
  await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'obligation_stopped',
    text: `${actorOf(user).name} stopped the recurring deadline: ${describeObligation(o)}`, data: { obligation_id: o.id } });
}

/** Create the next request or expected report once it is within the lead window. Idempotent. */
export async function generateDue(c, o, company, now = new Date()) {
  if (!o.active) return null;
  const next = dueAfter(o, now);
  if (!next) return null;
  if (now < new Date(next.due.getTime() - o.lead_days * 864e5)) return null;
  const { rows: existing } = await c.query('select id from items where obligation_id = $1 and due_at = $2', [o.id, next.due]);
  if (existing.length) return null;
  const title = `${o.title}, ${next.periodLabel}`;
  if (o.kind === 'request') {
    return createRequest(c, { user: null, company, title, dueAt: next.due, note: o.note, category: o.category, period: next.period, obligationId: o.id });
  }
  return createExpectedReport(c, { company, title, category: o.category, period: next.period, dueAt: next.due, obligationId: o.id });
}

export { fmtDay };
