// Client workspaces, the people in them, and recurring obligations.
import { checkTrialClients, firmLogoUrl } from './billing.js';
import { appendEvent } from './ledger.js';
import { HttpError, actorOf, sendLoginLink, COMPANY_SQL } from './auth.js';
import { dueAfter, fmtDay } from './dates.js';
import { checkTaxId, countryOf, isCountry, tzOf } from './countries.js';
import { createExpectedReport, createRequest } from './items.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validTaxId(country, raw) {
  const t = checkTaxId(country, raw);
  if (!t.ok) throw new HttpError(400, t.message);
  return t.value;
}

/** A new client workspace in the accountant's firm. The country defaults to the firm's. */
/** Tags group clients inside the firm ("monthly VAT", "restaurants"). Clients never see them. */
export function cleanTags(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[,|]/)).map((x) => String(x).trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean);
  const seen = new Set();
  return list.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10);
}
export async function setTags(c, { user, company, tags }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can tag clients.');
  // kept out of the shared activity log: tags are the firm's own notes
  await c.query('update companies set tags = $2 where id = $1', [company.id, cleanTags(tags)]);
}

export async function createCompany(c, { user, name, nif, city, country, tags }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can add clients.');
  if (!name) throw new HttpError(400, 'Enter the company name.');
  const { rows: [firm] } = await c.query('update firms set company_seq = company_seq + 1 where id = $1 returning *', [user.firm_id]);
  if (!firm) throw new HttpError(403, 'Your account is not linked to a firm.');
  await checkTrialClients(c, firm);
  if (country && !isCountry(country)) throw new HttpError(400, 'Choose the client’s country.');
  const cc = country || firm.country;
  const taxId = validTaxId(cc, nif);
  const { rows: [created] } = await c.query(
    'insert into companies (firm_id, no, name, nif, city, country, created_by, tags) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id',
    [firm.id, firm.company_seq, name, taxId, city || '', cc, user.id, cleanTags(tags)]);
  // someone who sees only assigned clients is assigned the client they create
  if (!user.all_clients) await c.query('insert into company_assignments (company_id, user_id) values ($1, $2)', [created.id, user.id]);
  const { rows: [co] } = await c.query(`${COMPANY_SQL} where c.id = $1`, [created.id]);
  const label = countryOf(cc).taxIdLabel;
  await appendEvent(c, { companyId: co.id, actor: actorOf(user), type: 'company_created',
    text: `${actorOf(user).name} created the workspace for ${name}${taxId ? ` (${label} ${taxId})` : ''}, ${countryOf(cc).name}`,
    data: { name, nif: taxId, city: city || '', country: cc } });
  return co;
}

export async function updateCompany(c, { user, company, name, nif, city, country }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can change client details.');
  if (country !== undefined && !isCountry(country)) throw new HttpError(400, 'Choose the client’s country.');
  const cc = country ?? company.country;
  const next = { name: name || company.name, nif: nif === undefined ? company.nif : validTaxId(cc, nif), city: city ?? company.city, country: cc };
  await c.query('update companies set name=$2, nif=$3, city=$4, country=$5 where id=$1', [company.id, next.name, next.nif, next.city, next.country]);
  await appendEvent(c, { companyId: company.id, actor: actorOf(user), type: 'company_updated',
    text: `${actorOf(user).name} updated the company details: ${next.name}, ${countryOf(cc).taxIdLabel} ${next.nif || '—'}, ${next.city || '—'}, ${countryOf(cc).name}`, data: next });
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
  const logoUrl = firmLogoUrl(company);
  await sendLoginLink(c, u, { invitedBy: actorOf(user).name, companyName: company.name, companyId: company.id, firmName: company.firm_name,
    logo: logoUrl && { url: logoUrl, alt: company.firm_name } });
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NTH = ['', 'following', 'second', 'third'];
function when(o) {
  const off = o.month_offset || 1;
  if (o.frequency === 'monthly') return `every month, due day ${o.due_day} of the ${NTH[off]} month`;
  if (o.frequency === 'quarterly') return off === 1 ? `every quarter, due day ${o.due_day} of January, April, July and October`
    : `every quarter, due day ${o.due_day} of the ${NTH[off]} month after the quarter`;
  return `every year, due ${o.due_day} ${MONTHS[(o.due_month || 1) - 1]}`;
}
export const describeObligation = (o) => `${o.kind === 'request' ? 'Client uploads' : 'Accountant sends'} “${o.title}” ${when(o)}`;

export async function createObligation(c, { user, company, kind, title, category, frequency, dueDay, dueMonth, monthOffset, leadDays, note }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can set up recurring deadlines.');
  if (!['request', 'report'].includes(kind)) throw new HttpError(400, 'Choose who delivers: the client or the accountant.');
  if (!['monthly', 'quarterly', 'yearly'].includes(frequency)) throw new HttpError(400, 'Choose how often.');
  if (!title) throw new HttpError(400, 'Enter a title.');
  const day = Number(dueDay);
  if (!(day >= 1 && day <= 31)) throw new HttpError(400, 'The due day must be between 1 and 31.');
  const month = frequency === 'yearly' ? Number(dueMonth) : null;
  if (frequency === 'yearly' && !(month >= 1 && month <= 12)) throw new HttpError(400, 'Choose the month for a yearly deadline.');
  const lead = Math.min(60, Math.max(0, Number(leadDays ?? 7) || 0));
  const offset = frequency === 'yearly' ? 1 : Math.min(3, Math.max(1, Number(monthOffset ?? 1) || 1));
  const { rows: [o] } = await c.query(
    `insert into obligations (company_id, kind, title, category, frequency, due_day, due_month, month_offset, lead_days, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [company.id, kind, title, category || (kind === 'request' ? 'Other' : 'Tax return'), frequency, day, month, offset, lead, note || '', user.id]);
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
  const next = dueAfter(o, now, tzOf(company.country));
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
