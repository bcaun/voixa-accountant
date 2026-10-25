// Background recognition of uploaded bank statements and invoices.
// Uploads queue a job in the same transaction; a worker reads the file, stores
// the extracted data, logs what it found, and then looks for payment matches.
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { appendEvent } from '../ledger.js';
import { storage } from '../storage.js';
import { SYSTEM } from '../items.js';
import { AiError, aiAvailable, readWithAi } from './ai.js';
import { costOf } from './pricing.js';
import { looksLikeNorma43, parseNorma43 } from './norma43.js';
import { looksLikeCamt053, parseCamt053 } from './camt053.js';
import { looksLikeCsv, parseCsv } from './csv.js';
import { extractRefs, guessCounterparty, nameSimilarity, normRef } from './refs.js';
import { fmtMoney, matchCompany } from './matching.js';

const KIND_BY_CATEGORY = { 'Bank statement': 'statement', 'Invoice': 'invoice' };
export const recognitionKind = (item, asKind) => asKind || KIND_BY_CATEGORY[item.category] || null;

/** Queue recognition of one file version, inside the caller's transaction. No-op for other document types. */
export async function enqueueRecognition(c, item, version, asKind) {
  const kind = recognitionKind(item, asKind);
  if (!kind) return false;
  await c.query('insert into jobs (kind, item_id, version_id, as_kind) values ($1,$2,$3,$4)', ['recognise', item.id, version.id, kind]);
  return true;
}

let running = null;
/** Work through queued jobs. Safe to call often; concurrent calls share one run. */
export function processJobs() {
  running ??= (async () => {
    try {
      for (;;) {
        const { rows: [job] } = await pool.query(
          `update jobs set status = 'running', attempts = attempts + 1, updated_at = now()
           where id = (select id from jobs where (status = 'queued' or (status = 'failed' and attempts < 3)) and run_after <= now()
                       order by id limit 1 for update skip locked)
           returning *`);
        if (!job) break;
        try {
          await recognise(job);
          await pool.query(`update jobs set status = 'done', error = null, updated_at = now() where id = $1`, [job.id]);
        } catch (err) {
          const final = job.attempts >= 3;
          await pool.query(`update jobs set status = 'failed', error = $2, run_after = now() + interval '2 minutes', updated_at = now() where id = $1`,
            [job.id, String(err.message || err)]);
          if (final) await saveFailure(job, 'failed', err.message || String(err)).catch(() => {});
          else console.error('recognition', job.id, err.message);
        }
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

async function readAll(stream) {
  const chunks = [];
  for await (const ch of stream) chunks.push(ch);
  return Buffer.concat(chunks);
}

function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

/** What kind of file is this, by its bytes rather than its name. */
function sniff(buf, name) {
  if (buf.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString() === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.subarray(0, 4).toString('hex') === '504b0304') return /\.xlsx?$/i.test(name) ? 'excel' : 'zip';
  if (buf.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return 'excel';
  const sample = buf.subarray(0, 4000);
  const binary = sample.filter((b) => b === 0 || (b < 9)).length > 2;
  return binary ? 'binary' : 'text';
}

const isoDate = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null);
const round2 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const clip = (s, n = 500) => (s == null ? null : String(s).trim().slice(0, n) || null);
const maskIban = (iban) => (iban ? `${iban.slice(0, 4)} …${iban.slice(-4)}` : null);

class Unsupported extends Error {}

async function readStatement(job, type, buf, name) {
  if (type === 'text') {
    const text = decodeText(buf);
    if (looksLikeNorma43(text)) return { method: 'norma43', data: parseNorma43(text) };
    if (looksLikeCamt053(text)) return { method: 'camt053', data: parseCamt053(text) };
    if (looksLikeCsv(text)) {
      try { return { method: 'csv', data: parseCsv(text) }; } catch (err) {
        if (!aiAvailable()) throw new Unsupported(`The CSV columns were not recognised (${err.message}).`);
      }
    }
    if (!aiAvailable()) throw new Unsupported('This text file is not Norma 43, camt.053 or a bank CSV, and reading other formats needs the AI reader, which is not configured.');
    return ai(job, 'statement', { type: 'text', data: text.slice(0, 400000), name });
  }
  return readBinaryWithAi(job, 'statement', type, buf, name);
}

async function readBinaryWithAi(job, kind, type, buf, name) {
  if (type === 'excel') throw new Unsupported('Excel files are not read yet. Export the statement as CSV, Norma 43 (AEB 43) or PDF and upload that.');
  if (!['pdf', 'png', 'jpeg', 'gif', 'webp'].includes(type)) throw new Unsupported('This file type cannot be read. Upload a PDF, a photo, CSV, Norma 43 or camt.053.');
  if (!aiAvailable()) throw new Unsupported('Reading PDFs and images needs the AI reader, which is not configured on this server (ANTHROPIC_API_KEY).');
  if (buf.length > config.recognition.maxAiFileMb * 1048576) throw new Unsupported(`The file is larger than ${config.recognition.maxAiFileMb} MB, the limit for automatic reading.`);
  return ai(job, kind, { type, data: buf, name });
}

async function monthSpend() {
  const { rows: [r] } = await pool.query(`select coalesce(sum(cost_usd), 0)::float as spent from ai_usage where created_at >= date_trunc('month', now())`);
  return r.spent;
}

async function recordUsage(job, kind, spent, outcome) {
  if (!spent?.usage) return;
  const u = spent.usage;
  const { cost } = costOf(u, spent.model || config.recognition.model);
  const { rows: [it] } = await pool.query('select company_id from items where id = $1', [job.item_id]);
  await pool.query(
    `insert into ai_usage (company_id, item_id, version_id, kind, model, requested_model, outcome, input_tokens, output_tokens,
       cache_write_tokens, cache_read_tokens, cost_usd, usage) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [it.company_id, job.item_id, job.version_id, kind, spent.model || config.recognition.model, config.recognition.model, outcome,
      u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, cost, JSON.stringify(u)]);
}

async function ai(job, kind, file) {
  const budget = config.recognition.monthlyBudgetUsd;
  if (budget > 0 && (await monthSpend()) >= budget) {
    throw new Unsupported(`This month's AI reading budget ($${budget}) has been reached. The file can be read again next month, or after the budget is raised.`);
  }
  let res;
  try {
    res = await readWithAi(kind, file);
  } catch (err) {
    if (err instanceof AiError) {
      await recordUsage(job, kind, err.spent, err.outcome);
      throw new Unsupported(err.message);
    }
    throw err;
  }
  const { data, model, usage } = res;
  const wrongType = (kind === 'statement' && !data.is_bank_statement) || (kind === 'invoice' && !data.is_invoice);
  await recordUsage(job, kind, { model, usage }, wrongType ? 'not_a_match' : 'ok');
  if (kind === 'statement' && !data.is_bank_statement) throw new Unsupported('The file does not look like a bank statement.');
  if (kind === 'invoice' && !data.is_invoice) throw new Unsupported('The file does not look like an invoice.');
  return { method: 'ai', model, data };
}

/** Clean one transaction and add references found in its text. */
function normaliseTx(t, currency) {
  const purpose = String(t.purpose || '').replace(/\s+/g, ' ').trim();
  const refs = extractRefs(purpose);
  const upper = (a) => [...new Set((a || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  return {
    booking_date: isoDate(t.booking_date), value_date: isoDate(t.value_date),
    amount: round2(t.amount), currency: clip(t.currency, 3)?.toUpperCase() || currency || 'EUR',
    counterparty_name: clip(t.counterparty_name, 200) || clip(guessCounterparty(purpose), 200),
    counterparty_iban: clip(t.counterparty_iban, 40)?.replace(/\s/g, '').toUpperCase() || null,
    counterparty_tax_id: clip(t.counterparty_tax_id, 20)?.replace(/\s/g, '').toUpperCase() || refs.taxIds[0] || null,
    purpose: purpose.slice(0, 2000),
    invoice_refs: upper([...(t.invoice_numbers || []), ...(t.structured_refs || []).filter((r) => /\d/.test(r)), ...refs.invoices]).slice(0, 10),
    contract_refs: upper([...(t.contract_numbers || []), ...refs.contracts]).slice(0, 10),
    bank_reference: clip(t.bank_reference, 100),
  };
}

async function recognise(job) {
  const { rows: [ctx] } = await pool.query(
    `select row_to_json(i) as item, row_to_json(v) as version, row_to_json(c) as company
     from items i join versions v on v.id = $2 join companies c on c.id = i.company_id where i.id = $1`, [job.item_id, job.version_id]);
  if (!ctx) return;
  const { item, version, company } = ctx;
  const buf = await readAll(await storage.get(version.storage_key));
  const type = sniff(buf, version.file_name);
  let result;
  try {
    result = job.as_kind === 'statement'
      ? await readStatement(job, type, buf, version.file_name)
      : type === 'text'
        ? (aiAvailable() ? await ai(job, 'invoice', { type: 'text', data: decodeText(buf).slice(0, 400000), name: version.file_name })
          : (() => { throw new Unsupported('Reading invoices needs the AI reader, which is not configured on this server (ANTHROPIC_API_KEY).'); })())
        : await readBinaryWithAi(job, 'invoice', type, buf, version.file_name);
  } catch (err) {
    if (err instanceof Unsupported) return saveFailure(job, 'unsupported', err.message);
    throw err;
  }
  if (job.as_kind === 'statement') await saveStatement(job, item, version, company, result);
  else await saveInvoice(job, item, version, company, result);
}

async function replaceExtraction(c, job, company, fields) {
  await c.query('delete from extractions where version_id = $1 and kind = $2', [job.version_id, job.as_kind]);
  const { rows: [e] } = await c.query(
    `insert into extractions (company_id, item_id, version_id, kind, status, method, model, summary, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [company.id, job.item_id, job.version_id, job.as_kind, fields.status, fields.method || '', fields.model || null, JSON.stringify(fields.summary || {}), fields.error || null]);
  return e;
}

async function saveFailure(job, status, message) {
  await tx(async (c) => {
    const { rows: [item] } = await c.query('select * from items where id = $1', [job.item_id]);
    const { rows: [company] } = await c.query('select * from companies where id = $1', [item.company_id]);
    await replaceExtraction(c, job, company, { status, error: message });
    await appendEvent(c, { companyId: company.id, itemId: item.id, versionId: job.version_id, actor: SYSTEM, type: 'recognition_failed',
      text: `Automatic reading of the ${job.as_kind === 'statement' ? 'bank statement' : 'invoice'} did not work: ${message}`, data: { reason: message } });
  });
}

async function saveStatement(job, item, version, company, { method, model, data }) {
  const currency = clip(data.currency, 3)?.toUpperCase() || null;
  const txs = data.transactions.map((t) => normaliseTx(t, currency)).filter((t) => t.amount != null);
  const totalIn = txs.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const totalOut = txs.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0);
  const summary = {
    bank_name: clip(data.bank_name, 100), bank_code: data.bank_code || null, account_holder: clip(data.account_holder, 200),
    iban: clip(data.iban, 40)?.replace(/\s/g, '').toUpperCase() || null, account_number: data.account_number || null, currency,
    period_start: isoDate(data.period_start), period_end: isoDate(data.period_end),
    opening_balance: round2(data.opening_balance), closing_balance: round2(data.closing_balance),
    count: txs.length, total_in: round2(totalIn), total_out: round2(totalOut),
  };
  // a statement whose movements do not add up to its closing balance is flagged, not trusted
  if (summary.opening_balance != null && summary.closing_balance != null) {
    const diff = round2(summary.opening_balance + totalIn + totalOut - summary.closing_balance);
    summary.balance_check = Math.abs(diff) < 0.01 ? 'ok' : `off by ${fmtMoney(diff, currency)}`;
  }
  await tx(async (c) => {
    const e = await replaceExtraction(c, job, company, { status: 'done', method, model, summary });
    let line = 0;
    for (const t of txs) {
      line++;
      await c.query(
        `insert into bank_transactions (extraction_id, company_id, item_id, line, booking_date, value_date, amount, currency,
           counterparty_name, counterparty_iban, counterparty_tax_id, purpose, invoice_refs, contract_refs, bank_reference)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [e.id, company.id, item.id, line, t.booking_date, t.value_date, t.amount, t.currency, t.counterparty_name, t.counterparty_iban,
          t.counterparty_tax_id, t.purpose, t.invoice_refs, t.contract_refs, t.bank_reference]);
    }
    const withInv = txs.filter((t) => t.invoice_refs.length).length, withCtr = txs.filter((t) => t.contract_refs.length).length;
    const label = { norma43: 'Norma 43 file', camt053: 'camt.053 file', csv: 'CSV export', ai: 'AI reading of the document' }[method];
    await appendEvent(c, { companyId: company.id, itemId: item.id, versionId: version.id, actor: SYSTEM, type: 'statement_recognised',
      text: `Recognised ${[summary.bank_name, 'bank statement'].filter(Boolean).join(' ')}${summary.iban ? ` ${maskIban(summary.iban)}` : ''}`
        + `${summary.period_start ? `, ${summary.period_start} to ${summary.period_end}` : ''}: ${txs.length} transactions`
        + ` (${fmtMoney(totalIn, currency)} in, ${fmtMoney(-totalOut, currency)} out), ${withInv} with invoice numbers, ${withCtr} with contract numbers.`
        + `${summary.balance_check && summary.balance_check !== 'ok' ? ` Balance check: ${summary.balance_check}.` : ''} Source: ${label}.`,
      data: { extraction_id: e.id, method, count: txs.length, total_in: summary.total_in, total_out: summary.total_out, currency } });
    await matchCompany(c, company);
  });
}

function invoiceDirection(company, inv) {
  const id = normRef(company.nif).replace(/^ES/, '');
  const same = (tax, name) => (id && tax && normRef(tax).replace(/^ES/, '') === id) || nameSimilarity(name, company.name) >= 0.6;
  if (same(inv.issuer_tax_id, inv.issuer_name)) return 'issued';
  if (same(inv.recipient_tax_id, inv.recipient_name)) return 'received';
  return 'unknown';
}

async function saveInvoice(job, item, version, company, { method, model, data }) {
  const inv = {
    invoice_number: clip(data.invoice_number, 60), issue_date: isoDate(data.issue_date), due_date: isoDate(data.due_date),
    issuer_name: clip(data.issuer_name, 200), issuer_tax_id: clip(data.issuer_tax_id, 20)?.replace(/\s/g, '').toUpperCase() || null,
    recipient_name: clip(data.recipient_name, 200), recipient_tax_id: clip(data.recipient_tax_id, 20)?.replace(/\s/g, '').toUpperCase() || null,
    currency: clip(data.currency, 3)?.toUpperCase() || 'EUR', net_amount: round2(data.net_amount), tax_amount: round2(data.tax_amount),
    total_amount: round2(data.total_amount), contract_number: clip(data.contract_number, 60),
  };
  inv.direction = invoiceDirection(company, inv);
  await tx(async (c) => {
    const e = await replaceExtraction(c, job, company, { status: 'done', method, model, summary: inv });
    await c.query(
      `insert into invoice_data (extraction_id, company_id, item_id, invoice_number, issue_date, due_date, issuer_name, issuer_tax_id,
         recipient_name, recipient_tax_id, currency, net_amount, tax_amount, total_amount, contract_number, direction)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [e.id, company.id, item.id, inv.invoice_number, inv.issue_date, inv.due_date, inv.issuer_name, inv.issuer_tax_id, inv.recipient_name,
        inv.recipient_tax_id, inv.currency, inv.net_amount, inv.tax_amount, inv.total_amount, inv.contract_number, inv.direction]);
    const party = inv.direction === 'issued' ? `to ${inv.recipient_name || 'unknown customer'}` : `from ${inv.issuer_name || 'unknown supplier'}`;
    await appendEvent(c, { companyId: company.id, itemId: item.id, versionId: version.id, actor: SYSTEM, type: 'invoice_recognised',
      text: `Recognised invoice ${inv.invoice_number || '(no number)'} ${party}`
        + `${inv.total_amount != null ? `, total ${fmtMoney(inv.total_amount, inv.currency)}` : ''}${inv.issue_date ? `, dated ${inv.issue_date}` : ''}.`,
      data: { extraction_id: e.id, method, invoice_number: inv.invoice_number, total: inv.total_amount, currency: inv.currency, direction: inv.direction } });
    await matchCompany(c, company);
  });
}
