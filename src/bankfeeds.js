// Bank statements through open banking. The provider here is GoCardless Bank Account Data
// (formerly Nordigen), a licensed PSD2 account information service; another provider fits behind
// the same four calls (institutions, connect, finish, transactions).
//
// The client picks their bank and authorises read access there (usually 90 days). Pescada then
// fetches new booked movements on a schedule and stores each batch as a statement file in the
// workspace: fingerprinted, logged and matched to invoices like an upload. Movements already
// fetched are remembered, so nothing is imported twice.
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { pool, query, tx } from './db.js';
import { storage } from './storage.js';
import { HttpError, COMPANY_SQL } from './auth.js';
import { appendEvent, lockCompany } from './ledger.js';
import { createDocument, notify, SYSTEM } from './items.js';
import { processJobs } from './recognition/recognize.js';
import { flushEmails } from './mailer.js';

export const feedsOn = () => !!(config.bankFeeds.secretId && config.bankFeeds.secretKey);

let token = null;
async function gc(path, { method = 'GET', body } = {}) {
  const B = config.bankFeeds.apiBase;
  if (!token || token.until < Date.now()) {
    const r = await fetch(`${B}/api/v2/token/new/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ secret_id: config.bankFeeds.secretId, secret_key: config.bankFeeds.secretKey }) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access) throw new HttpError(502, 'The bank connection service did not accept our credentials.');
    token = { access: t.access, until: Date.now() + (Number(t.access_expires || 3600) - 60) * 1000 };
  }
  const r = await fetch(`${B}/api/v2${path}`, { method, headers: { Authorization: `Bearer ${token.access}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new HttpError(502, `Bank connection service: ${out.summary || out.detail || r.status}`), { upstream: r.status });
  return out;
}

export async function institutions(country) {
  if (!feedsOn()) throw new HttpError(503, 'Bank connections are not set up on this server.');
  const list = await gc(`/institutions/?country=${encodeURIComponent(String(country).toLowerCase())}`);
  return list.map((i) => ({ id: i.id, name: i.name, bic: i.bic, logo: i.logo }));
}

/** Start a connection: returns the bank's authorisation page. */
export async function connect({ user, company, institutionId }) {
  if (!feedsOn()) throw new HttpError(503, 'Bank connections are not set up on this server.');
  const inst = (await institutions(company.country)).find((i) => i.id === institutionId);
  if (!inst) throw new HttpError(400, 'Choose a bank from the list.');
  const reference = randomUUID();
  const agreement = await gc('/agreements/enduser/', { method: 'POST', body: { institution_id: inst.id, max_historical_days: 90, access_valid_for_days: 90, access_scope: ['balances', 'details', 'transactions'] } });
  const req = await gc('/requisitions/', { method: 'POST', body: { redirect: `${config.appUrl}/bank/callback`, institution_id: inst.id, reference, agreement: agreement.id,
    user_language: { ES: 'ES', IT: 'IT', FR: 'FR', DE: 'DE', PT: 'PT' }[company.country] || 'EN' } });
  await tx(async (c) => {
    await lockCompany(c, company.id);
    await c.query(`insert into bank_connections (company_id, provider, institution_id, institution_name, requisition_id, reference, created_by) values ($1,'gocardless',$2,$3,$4,$5,$6)`,
      [company.id, inst.id, inst.name, req.id, reference, user.id]);
    await appendEvent(c, { companyId: company.id, actor: { type: user.role, id: user.id, name: user.name || user.email }, type: 'bank_connect_started',
      text: `${user.name || user.email} started connecting ${inst.name} for automatic statements` });
  });
  return req.link;
}

/** The bank sends the person back here (?ref=…) after they authorised (or refused) access. */
export async function finish(reference) {
  const { rows: [conn] } = await query('select * from bank_connections where reference = $1', [reference]);
  if (!conn) return null;
  const r = await gc(`/requisitions/${conn.requisition_id}/`);
  if (r.status !== 'LN' || !(r.accounts || []).length) {
    await query(`update bank_connections set status = 'error', last_error = $2 where id = $1`, [conn.id, `Not authorised (status ${r.status})`]);
    return { companyId: conn.company_id, ok: false };
  }
  const accounts = [];
  for (const id of r.accounts) {
    const d = await gc(`/accounts/${id}/details/`).catch(() => ({ account: {} }));
    accounts.push({ id, iban: d.account?.iban || null, currency: d.account?.currency || 'EUR', name: d.account?.name || d.account?.ownerName || null });
  }
  await tx(async (c) => {
    await lockCompany(c, conn.company_id);
    await c.query(`update bank_connections set status = 'linked', accounts = $2, linked_at = now(), expires_at = now() + interval '90 days', last_error = null where id = $1`, [conn.id, JSON.stringify(accounts)]);
    await appendEvent(c, { companyId: conn.company_id, actor: SYSTEM, type: 'bank_connected',
      text: `${conn.institution_name} is connected: ${accounts.length} account${accounts.length === 1 ? '' : 's'} (${accounts.map((a) => a.iban ? `…${a.iban.slice(-4)}` : a.id.slice(0, 6)).join(', ')}). New movements are fetched automatically until access ends in 90 days.` });
  });
  await syncConnection(conn.id).catch((err) => console.error('bank feed', err.message));
  return { companyId: conn.company_id, ok: true };
}

const iso = (d) => (d ? String(d).slice(0, 10) : null);

/** Fetch new movements of one connection and store them as a statement file per account. */
export async function syncConnection(id, now = new Date()) {
  const { rows: [conn] } = await query(`select * from bank_connections where id = $1 and status = 'linked'`, [id]);
  if (!conn) return 0;
  if (conn.expires_at && new Date(conn.expires_at) < now) return expire(conn);
  let created = 0;
  for (const acc of conn.accounts) {
    const from = iso(conn.last_sync_at ? new Date(new Date(conn.last_sync_at).getTime() - 5 * 864e5).toISOString() : new Date(now.getTime() - 90 * 864e5).toISOString());
    let data;
    try { data = await gc(`/accounts/${acc.id}/transactions/?date_from=${from}`); } catch (err) {
      if (err.upstream === 401 || err.upstream === 403) return expire(conn);
      await query('update bank_connections set last_error = $2 where id = $1', [conn.id, err.message]);
      throw err;
    }
    const booked = data.transactions?.booked || [];
    const { rows: seen } = await query('select tx_id from bank_feed_seen where connection_id = $1 and tx_id = any($2)', [conn.id, booked.map(txId)]);
    const known = new Set(seen.map((r) => r.tx_id));
    const fresh = booked.filter((t) => !known.has(txId(t)));
    if (!fresh.length) continue;
    const dates = fresh.map((t) => iso(t.bookingDate || t.valueDate)).filter(Boolean).sort();
    const doc = {
      format: 'pescada-bankfeed-1', provider: 'GoCardless Bank Account Data', bank: conn.institution_name, iban: acc.iban, currency: acc.currency,
      fetched_at: now.toISOString(), period_start: dates[0], period_end: dates[dates.length - 1],
      transactions: fresh.map((t) => {
        const amount = Number(t.transactionAmount?.amount);
        const out = amount < 0;
        return { id: txId(t), booking_date: iso(t.bookingDate), value_date: iso(t.valueDate), amount, currency: t.transactionAmount?.currency || acc.currency,
          counterparty_name: (out ? t.creditorName : t.debtorName) || null, counterparty_iban: (out ? t.creditorAccount?.iban : t.debtorAccount?.iban) || null,
          purpose: [t.remittanceInformationUnstructured, ...(t.remittanceInformationUnstructuredArray || []), t.remittanceInformationStructured, t.additionalInformation].filter(Boolean).join(' '),
          bank_reference: t.internalTransactionId || t.transactionId || null };
      }),
    };
    const buf = Buffer.from(JSON.stringify(doc, null, 1));
    const file = { key: `companies/${conn.company_id}/${randomUUID()}`, name: `${conn.institution_name} ${acc.iban ? `…${acc.iban.slice(-4)} ` : ''}${doc.period_start} to ${doc.period_end}.json`,
      mime: 'application/json', size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), scan: { status: 'clean' } };
    await storage.put(file.key, Readable.from(buf), file.mime);
    await tx(async (c) => {
      await lockCompany(c, conn.company_id);
      const { rows: [company] } = await c.query(`${COMPANY_SQL} where c.id = $1`, [conn.company_id]);
      const { rows: [user] } = await c.query('select * from users where id = $1', [conn.created_by]);
      await createDocument(c, { user, company, file, category: 'Bank statement', period: (doc.period_end || '').slice(0, 7),
        note: `Fetched automatically from ${conn.institution_name} through open banking (${fresh.length} new movement${fresh.length === 1 ? '' : 's'})`, requestId: null });
      for (const t of doc.transactions) await c.query('insert into bank_feed_seen (connection_id, tx_id) values ($1,$2) on conflict do nothing', [conn.id, t.id]);
    });
    created++;
  }
  await query('update bank_connections set last_sync_at = $2, last_error = null where id = $1', [conn.id, now]);
  if (created) { processJobs().catch(() => {}); flushEmails().catch(() => {}); }
  return created;
}

const txId = (t) => String(t.transactionId || t.internalTransactionId || createHash('sha256').update(JSON.stringify([t.bookingDate, t.transactionAmount, t.remittanceInformationUnstructured, t.creditorName, t.debtorName])).digest('hex').slice(0, 32));

async function expire(conn) {
  await tx(async (c) => {
    await lockCompany(c, conn.company_id);
    await c.query(`update bank_connections set status = 'expired' where id = $1`, [conn.id]);
    const { rows: [company] } = await c.query(`${COMPANY_SQL} where c.id = $1`, [conn.company_id]);
    await appendEvent(c, { companyId: conn.company_id, actor: SYSTEM, type: 'bank_expired', text: `Access to ${conn.institution_name} has ended. Connect the bank again to keep statements coming.` });
    await notify(c, { company, item: null, side: 'client', kind: 'reminder', msg: (t) => ({ subject: t('Reconnect {bank}', { bank: conn.institution_name }), heading: t('Your bank connection has ended'),
      lines: [t('The automatic statements from {bank} have stopped because the bank’s 90-day authorisation ended.', { bank: conn.institution_name }), t('Open the workspace and connect the bank again; it takes a minute.')] }) });
  });
  return 0;
}

/** Scheduler: sync every linked connection not synced in the last BANK_FEED_SYNC_HOURS. */
export async function syncAll(now = new Date()) {
  if (!feedsOn()) return 0;
  const { rows } = await pool.query(`select id from bank_connections where status = 'linked' and (last_sync_at is null or last_sync_at < $1)`,
    [new Date(now.getTime() - config.bankFeeds.syncHours * 36e5)]);
  let n = 0;
  for (const r of rows) { try { n += await syncConnection(r.id, now); } catch (err) { console.error('bank feed', r.id, err.message); } }
  return n;
}

export async function removeConnection({ user, company, id }) {
  await tx(async (c) => {
    await lockCompany(c, company.id);
    const { rows: [conn] } = await c.query(`update bank_connections set status = 'removed' where id = $1 and company_id = $2 and status <> 'removed' returning *`, [id, company.id]);
    if (!conn) throw new HttpError(404, 'That bank connection does not exist.');
    await appendEvent(c, { companyId: company.id, actor: { type: user.role, id: user.id, name: user.name || user.email }, type: 'bank_disconnected', text: `${user.name || user.email} disconnected ${conn.institution_name}` });
  });
  if (feedsOn()) {
    const { rows: [conn] } = await query('select requisition_id from bank_connections where id = $1', [id]);
    await gc(`/requisitions/${conn.requisition_id}/`, { method: 'DELETE' }).catch(() => {});
  }
}

