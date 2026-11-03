// Bank statements through open banking. Two licensed PSD2 account information providers fit behind
// the same calls (institutions, start, finish, transactions, remove): Enable Banking (used when
// ENABLE_BANKING_APP_ID is set) and GoCardless Bank Account Data. A connection remembers its provider,
// so connections made with one keep working if the server later switches to the other.
//
// The client picks their bank and authorises read access there (up to 90 days). Pescada then
// fetches new booked movements on a schedule and stores each batch as a statement file in the
// workspace: fingerprinted, logged and matched to invoices like an upload. Movements already
// fetched are remembered, so nothing is imported twice.
import { createHash, createSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { pool, query, tx } from './db.js';
import { storage } from './storage.js';
import { HttpError, COMPANY_SQL } from './auth.js';
import { appendEvent, lockCompany } from './ledger.js';
import { createDocument, notify, SYSTEM } from './items.js';
import { processJobs } from './recognition/recognize.js';
import { flushEmails } from './mailer.js';

const DAYS = 90;
const callbackUrl = () => `${config.appUrl}/bank/callback`;
const upstreamError = (status, msg) => Object.assign(new HttpError(502, `Bank connection service: ${msg || status}`), { upstream: status });

/* ---------- GoCardless Bank Account Data ---------- */
let gcToken = null;
async function gc(path, { method = 'GET', body } = {}) {
  const B = config.bankFeeds.apiBase;
  if (!gcToken || gcToken.until < Date.now()) {
    const r = await fetch(`${B}/api/v2/token/new/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ secret_id: config.bankFeeds.secretId, secret_key: config.bankFeeds.secretKey }) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access) throw new HttpError(502, 'The bank connection service did not accept our credentials.');
    gcToken = { access: t.access, until: Date.now() + (Number(t.access_expires || 3600) - 60) * 1000 };
  }
  const r = await fetch(`${B}/api/v2${path}`, { method, headers: { Authorization: `Bearer ${gcToken.access}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw upstreamError(r.status, out.summary || out.detail);
  return out;
}

const gocardless = {
  name: 'gocardless', label: 'GoCardless Bank Account Data',
  on: () => !!(config.bankFeeds.secretId && config.bankFeeds.secretKey),
  async institutions(country) {
    const list = await gc(`/institutions/?country=${encodeURIComponent(String(country).toLowerCase())}`);
    return list.map((i) => ({ id: i.id, name: i.name, logo: i.logo }));
  },
  async start({ inst, company, reference }) {
    const agreement = await gc('/agreements/enduser/', { method: 'POST', body: { institution_id: inst.id, max_historical_days: DAYS, access_valid_for_days: DAYS, access_scope: ['balances', 'details', 'transactions'] } });
    const req = await gc('/requisitions/', { method: 'POST', body: { redirect: callbackUrl(), institution_id: inst.id, reference, agreement: agreement.id,
      user_language: { ES: 'ES', IT: 'IT', FR: 'FR', DE: 'DE', PT: 'PT' }[company.country] || 'EN' } });
    return { link: req.link, requisitionId: req.id };
  },
  async finish(conn) {
    const r = await gc(`/requisitions/${conn.requisition_id}/`);
    if (r.status !== 'LN' || !(r.accounts || []).length) return { ok: false, reason: `Not authorised (status ${r.status})` };
    const accounts = [];
    for (const id of r.accounts) {
      const d = await gc(`/accounts/${id}/details/`).catch(() => ({ account: {} }));
      accounts.push({ id, iban: d.account?.iban || null, currency: d.account?.currency || 'EUR', name: d.account?.name || d.account?.ownerName || null });
    }
    return { ok: true, accounts, validUntil: new Date(Date.now() + DAYS * 864e5) };
  },
  async transactions(conn, acc, from) {
    const data = await gc(`/accounts/${acc.id}/transactions/?date_from=${from}`);
    return (data.transactions?.booked || []).map((t) => {
      const amount = Number(t.transactionAmount?.amount);
      const out = amount < 0;
      return { id: String(t.transactionId || t.internalTransactionId || fingerprint([t.bookingDate, t.transactionAmount, t.remittanceInformationUnstructured, t.creditorName, t.debtorName])),
        booking_date: iso(t.bookingDate), value_date: iso(t.valueDate), amount, currency: t.transactionAmount?.currency || acc.currency,
        counterparty_name: (out ? t.creditorName : t.debtorName) || null, counterparty_iban: (out ? t.creditorAccount?.iban : t.debtorAccount?.iban) || null,
        purpose: [t.remittanceInformationUnstructured, ...(t.remittanceInformationUnstructuredArray || []), t.remittanceInformationStructured, t.additionalInformation].filter(Boolean).join(' '),
        bank_reference: t.internalTransactionId || t.transactionId || null };
    });
  },
  async remove(conn) { if (conn.requisition_id) await gc(`/requisitions/${conn.requisition_id}/`, { method: 'DELETE' }); },
};

/* ---------- Enable Banking ---------- */
// Requests are signed with a short-lived JWT (RS256) made with the application's private key;
// the key id is the application id shown in the Enable Banking control panel.
let ebKey = null;
function ebJwt() {
  const c = config.enableBanking;
  ebKey ||= c.privateKey || readFileSync(c.keyFile, 'utf8');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ typ: 'JWT', alg: 'RS256', kid: c.appId })}.${b64({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 })}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(ebKey).toString('base64url')}`;
}
async function eb(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${config.enableBanking.apiBase}${path}`, { method, headers: { Authorization: `Bearer ${ebJwt()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(upstreamError(r.status, out.message || out.error || out.detail), { code: out.error || out.code });
  return out;
}
const PSU = { business: 'business', personal: 'personal' };

const enableBanking = {
  name: 'enablebanking', label: 'Enable Banking',
  on: () => !!(config.enableBanking.appId && (config.enableBanking.privateKey || config.enableBanking.keyFile)),
  async institutions(country) {
    const { aspsps = [] } = await eb(`/aspsps?country=${encodeURIComponent(String(country).toUpperCase())}&service=AIS`);
    // a bank with separate business and personal access appears twice, so the client picks the right one
    const out = [];
    for (const a of aspsps) {
      const types = (a.psu_types || ['personal']).filter((p) => PSU[p]);
      for (const p of types.length ? types : ['personal']) {
        out.push({ id: `${p}:${a.name}`, name: a.name, logo: a.logo, kind: types.length > 1 ? p : undefined,
          psuType: p, aspsp: { name: a.name, country: a.country }, maxSeconds: Number(a.maximum_consent_validity) || 0 });
      }
    }
    return out.sort((x, y) => x.name.localeCompare(y.name) || (x.kind === 'business' ? -1 : 1));
  },
  async start({ inst, company, reference }) {
    const seconds = Math.min(DAYS * 86400, inst.maxSeconds || DAYS * 86400);
    const r = await eb('/auth', { method: 'POST', body: {
      access: { valid_until: new Date(Date.now() + seconds * 1000).toISOString() },
      aspsp: inst.aspsp, state: reference, redirect_url: callbackUrl(), psu_type: inst.psuType,
      language: { ES: 'es', IT: 'it', FR: 'fr', DE: 'de', PT: 'pt' }[company.country] || 'en' } });
    return { link: r.url, requisitionId: null };
  },
  async finish(conn, params) {
    if (params.error || !params.code) return { ok: false, reason: `Not authorised (${String(params.error || 'no code').slice(0, 80)})` };
    const s = await eb('/sessions', { method: 'POST', body: { code: String(params.code) } });
    const accounts = [];
    for (const a of s.accounts || []) {
      const d = typeof a === 'string' ? await eb(`/accounts/${a}/details`).catch(() => ({ uid: a })) : a;
      accounts.push({ id: d.uid || a, iban: d.account_id?.iban || null, currency: d.currency || 'EUR', name: d.name || d.product || null });
    }
    if (!accounts.length) return { ok: false, reason: 'Not authorised (no accounts shared)', sessionId: s.session_id };
    const until = s.access?.valid_until ? new Date(s.access.valid_until) : new Date(Date.now() + DAYS * 864e5);
    return { ok: true, accounts, validUntil: until, sessionId: s.session_id };
  },
  async transactions(conn, acc, from) {
    const out = [];
    let key = null, pages = 0;
    do {
      const q = new URLSearchParams({ date_from: from });
      if (key) q.set('continuation_key', key);
      const r = await eb(`/accounts/${encodeURIComponent(acc.id)}/transactions?${q}`);
      for (const t of r.transactions || []) {
        if (t.status && t.status !== 'BOOK') continue; // pending movements come later, booked
        const out_ = t.credit_debit_indicator === 'DBIT';
        const amount = Math.abs(Number(t.transaction_amount?.amount)) * (out_ ? -1 : 1);
        const party = out_ ? t.creditor : t.debtor, partyAcc = out_ ? t.creditor_account : t.debtor_account;
        out.push({ id: String(t.entry_reference || t.transaction_id || fingerprint([t.booking_date, t.transaction_amount, t.credit_debit_indicator, t.remittance_information, party?.name])),
          booking_date: iso(t.booking_date), value_date: iso(t.value_date), amount, currency: t.transaction_amount?.currency || acc.currency,
          counterparty_name: party?.name || null, counterparty_iban: partyAcc?.iban || null,
          purpose: [...(t.remittance_information || []), t.note].filter(Boolean).join(' '),
          bank_reference: t.entry_reference || t.transaction_id || null });
      }
      key = r.continuation_key || null;
    } while (key && ++pages < 50);
    return out;
  },
  async remove(conn) { if (conn.requisition_id) await eb(`/sessions/${encodeURIComponent(conn.requisition_id)}`, { method: 'DELETE' }); },
};

const PROVIDERS = { enablebanking: enableBanking, gocardless };
/** The provider new connections use: Enable Banking when configured, otherwise GoCardless. */
const current = () => [enableBanking, gocardless].find((p) => p.on()) || null;
const providerOf = (conn) => PROVIDERS[conn.provider] || gocardless;
const fingerprint = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 32);

export const feedsOn = () => !!current();

export async function institutions(country) {
  const p = current();
  if (!p) throw new HttpError(503, 'Bank connections are not set up on this server.');
  return (await p.institutions(country)).map(({ id, name, logo, kind }) => ({ id, name, logo, kind }));
}

/** Start a connection: returns the bank's authorisation page. */
export async function connect({ user, company, institutionId }) {
  const p = current();
  if (!p) throw new HttpError(503, 'Bank connections are not set up on this server.');
  const inst = (await p.institutions(company.country)).find((i) => i.id === institutionId);
  if (!inst) throw new HttpError(400, 'Choose a bank from the list.');
  const reference = randomUUID();
  const { link, requisitionId } = await p.start({ inst, company, reference });
  await tx(async (c) => {
    await lockCompany(c, company.id);
    await c.query(`insert into bank_connections (company_id, provider, institution_id, institution_name, requisition_id, reference, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
      [company.id, p.name, inst.id, inst.name, requisitionId, reference, user.id]);
    await appendEvent(c, { companyId: company.id, actor: { type: user.role, id: user.id, name: user.name || user.email }, type: 'bank_connect_started',
      text: `${user.name || user.email} started connecting ${inst.name} for automatic statements` });
  });
  return link;
}

/**
 * The bank sends the person back here after they authorised (or refused) access:
 * GoCardless with ?ref=…, Enable Banking with ?state=…&code=… (or &error=…).
 */
export async function finish(params = {}) {
  const reference = String(params.ref || params.state || '');
  if (!reference) return null;
  const { rows: [conn] } = await query(`select * from bank_connections where reference = $1 and status = 'pending'`, [reference]);
  if (!conn) {
    const { rows: [done] } = await query('select company_id, status from bank_connections where reference = $1', [reference]);
    return done ? { companyId: done.company_id, ok: done.status === 'linked' } : null; // a reload of the same page
  }
  const r = await providerOf(conn).finish(conn, params);
  if (!r.ok) {
    await query(`update bank_connections set status = 'error', last_error = $2, requisition_id = coalesce(requisition_id, $3) where id = $1`, [conn.id, r.reason, r.sessionId || null]);
    return { companyId: conn.company_id, ok: false };
  }
  const { accounts } = r;
  const days = Math.max(1, Math.round((r.validUntil - Date.now()) / 864e5));
  await tx(async (c) => {
    await lockCompany(c, conn.company_id);
    await c.query(`update bank_connections set status = 'linked', accounts = $2, linked_at = now(), expires_at = $3, last_error = null, requisition_id = coalesce($4, requisition_id) where id = $1`,
      [conn.id, JSON.stringify(accounts), r.validUntil, r.sessionId || null]);
    await appendEvent(c, { companyId: conn.company_id, actor: SYSTEM, type: 'bank_connected',
      text: `${conn.institution_name} is connected: ${accounts.length} account${accounts.length === 1 ? '' : 's'} (${accounts.map((a) => a.iban ? `…${a.iban.slice(-4)}` : String(a.id).slice(0, 6)).join(', ')}). New movements are fetched automatically until access ends in ${days} day${days === 1 ? '' : 's'}.` });
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
    let list;
    try { list = await providerOf(conn).transactions(conn, acc, from); } catch (err) {
      if (err.upstream === 401 || err.upstream === 403 || /EXPIRED|REVOKED|CLOSED_SESSION|INVALID_SESSION/i.test(err.code || '')) return expire(conn);
      await query('update bank_connections set last_error = $2 where id = $1', [conn.id, err.message]);
      throw err;
    }
    const { rows: seen } = await query('select tx_id from bank_feed_seen where connection_id = $1 and tx_id = any($2)', [conn.id, list.map((t) => t.id)]);
    const known = new Set(seen.map((r) => r.tx_id));
    const fresh = list.filter((t, n) => !known.has(t.id) && list.findIndex((u) => u.id === t.id) === n);
    if (!fresh.length) continue;
    const dates = fresh.map((t) => t.booking_date || t.value_date).filter(Boolean).sort();
    const doc = {
      format: 'pescada-bankfeed-1', provider: providerOf(conn).label, bank: conn.institution_name, iban: acc.iban, currency: acc.currency,
      fetched_at: now.toISOString(), period_start: dates[0], period_end: dates[dates.length - 1],
      transactions: fresh,
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
  // only firms whose plan includes it (Pro, or the trial); connections of other firms wait
  const { rows } = await pool.query(`select b.id from bank_connections b join companies c on c.id = b.company_id join firms f on f.id = c.firm_id
     where b.status = 'linked' and (b.last_sync_at is null or b.last_sync_at < $1) and (f.tier = 'pro' or f.plan = 'trial')`,
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
  const { rows: [conn] } = await query('select provider, requisition_id from bank_connections where id = $1', [id]);
  if (providerOf(conn).on()) await providerOf(conn).remove(conn).catch(() => {});
}

