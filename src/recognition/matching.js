// Match bank transactions to the invoices uploaded in the same workspace.
// A match is only a suggestion until an accountant confirms it; both the
// suggestion and the decision are written to the evidence log.
import { appendEvent } from '../ledger.js';
import { HttpError, actorOf } from '../auth.js';
import { SYSTEM, refOf } from '../items.js';
import { extractRefs, guessCounterparty, nameSimilarity, normRef, sameRef } from './refs.js';

export const MATCH_THRESHOLD = 50;
const DAY = 864e5;

export const fmtMoney = (n, ccy) => `${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy || ''}`.trim();
const toDate = (d) => (d ? new Date(typeof d === 'string' ? `${d.slice(0, 10)}T00:00:00Z` : d) : null);

/** Score how likely a transaction pays an invoice. Returns { score, reasons }. */
export function scoreMatch(tx, inv) {
  const reasons = [];
  let score = 0;
  const amount = Number(tx.amount);
  const total = inv.total_amount == null ? null : Number(inv.total_amount);

  const num = inv.invoice_number;
  if (num && ((tx.invoice_refs || []).some((r) => sameRef(r, num)) || (normRef(num).length >= 5 && normRef(tx.purpose).includes(normRef(num))))) {
    score += 60; reasons.push(`invoice number ${num} appears in the payment`);
  }

  const sameCurrency = !tx.currency || !inv.currency || tx.currency.toUpperCase() === inv.currency.toUpperCase();
  if (total && sameCurrency) {
    const diff = Math.abs(Math.abs(amount) - total);
    if (diff <= 0.01) { score += 30; reasons.push('same amount'); } else if (diff / total <= 0.02) { score += 10; reasons.push('amount within 2%'); }
  }

  if ((inv.direction === 'received' && amount < 0) || (inv.direction === 'issued' && amount > 0)) score += 5;
  else if ((inv.direction === 'received' && amount > 0) || (inv.direction === 'issued' && amount < 0)) { score -= 25; reasons.push('money moves the wrong way for this invoice'); }

  const other = inv.direction === 'issued' ? [[inv.recipient_name, inv.recipient_tax_id]]
    : inv.direction === 'received' ? [[inv.issuer_name, inv.issuer_tax_id]]
      : [[inv.issuer_name, inv.issuer_tax_id], [inv.recipient_name, inv.recipient_tax_id]];
  const txTaxIds = new Set([tx.counterparty_tax_id, ...extractRefs(tx.purpose).taxIds].filter(Boolean).map(normRef));
  const taxHit = other.some(([, id]) => id && (txTaxIds.has(normRef(id)) || txTaxIds.has(normRef(id).replace(/^ES/, ''))));
  if (taxHit) { score += 25; reasons.push('tax ID matches'); }
  const txName = tx.counterparty_name || guessCounterparty(tx.purpose) || tx.purpose;
  const sim = Math.max(0, ...other.map(([n]) => nameSimilarity(txName, n)));
  if (sim >= 0.6) { score += 15; reasons.push('counterparty name matches'); } else if (sim >= 0.34) { score += 7; reasons.push('counterparty name is similar'); }

  const paid = toDate(tx.booking_date || tx.value_date), issued = toDate(inv.issue_date);
  if (paid && issued) {
    const days = (paid - issued) / DAY;
    if (days >= -10 && days <= 180) score += 5;
    else if (days < -30) { score -= 15; reasons.push('paid before the invoice date'); }
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** Best invoices for one transaction: the top score above the threshold, plus any within 5 points of it. */
export function bestMatches(tx, invoices) {
  const scored = invoices.map((inv) => ({ inv, ...scoreMatch(tx, inv) })).filter((m) => m.score >= MATCH_THRESHOLD).sort((a, b) => b.score - a.score);
  return scored.filter((m) => m.score >= scored[0]?.score - 5).slice(0, 3);
}

/** Look for new matches across a workspace's current statements and invoices. Runs inside a transaction. */
export async function matchCompany(c, company) {
  const { rows: txs } = await c.query(
    `select t.*, i.seq as item_seq from bank_transactions t
     join extractions e on e.id = t.extraction_id join items i on i.id = t.item_id join versions v on v.id = e.version_id and v.version = i.version
     where t.company_id = $1 and e.status = 'done'
       and not exists (select 1 from payment_matches m where m.transaction_id = t.id and m.status = 'confirmed')`, [company.id]);
  const { rows: invs } = await c.query(
    `select d.*, i.seq as item_seq, i.title from invoice_data d
     join extractions e on e.id = d.extraction_id join items i on i.id = d.item_id join versions v on v.id = e.version_id and v.version = i.version
     where d.company_id = $1 and e.status = 'done'
       and not exists (select 1 from payment_matches m where m.invoice_item_id = d.item_id and m.status = 'confirmed')`, [company.id]);
  if (!txs.length || !invs.length) return 0;
  const { rows: seen } = await c.query('select transaction_id, invoice_item_id from payment_matches where company_id = $1', [company.id]);
  const known = new Set(seen.map((s) => `${s.transaction_id}:${s.invoice_item_id}`));
  let n = 0;
  for (const tx of txs) {
    for (const m of bestMatches(tx, invs)) {
      if (known.has(`${tx.id}:${m.inv.item_id}`)) continue;
      const { rows: [pm] } = await c.query(
        `insert into payment_matches (company_id, transaction_id, invoice_item_id, score, reasons) values ($1,$2,$3,$4,$5)
         on conflict do nothing returning id`, [company.id, tx.id, m.inv.item_id, m.score, m.reasons]);
      if (!pm) continue;
      const day = tx.booking_date ? new Date(tx.booking_date).toISOString().slice(0, 10) : 'an unknown date';
      await appendEvent(c, { companyId: company.id, itemId: m.inv.item_id, actor: SYSTEM, type: 'payment_suggested',
        text: `Possible payment for invoice ${m.inv.invoice_number || m.inv.title}: ${fmtMoney(tx.amount, tx.currency)} on ${day} `
          + `(statement ${refOf(company, { seq: tx.item_seq })}, line ${tx.line}). Match ${m.score}%: ${m.reasons.join(', ')}.`,
        data: { match_id: pm.id, transaction_id: tx.id, statement_item_id: tx.item_id, line: tx.line, amount: Number(tx.amount), currency: tx.currency, score: m.score } });
      n++;
    }
  }
  return n;
}

/** An accountant confirms or rejects a suggested match. */
export async function decideMatch(c, { user, company, matchId, confirm }) {
  if (user.role !== 'accountant') throw new HttpError(403, 'Only accountants can confirm payment matches.');
  const { rows: [m] } = await c.query(
    `select m.*, t.amount, t.currency, t.booking_date, t.line, si.seq as statement_seq, ii.title,
            (select d.invoice_number from invoice_data d where d.item_id = m.invoice_item_id limit 1) as invoice_number
     from payment_matches m join bank_transactions t on t.id = m.transaction_id
     join items si on si.id = t.item_id join items ii on ii.id = m.invoice_item_id
     where m.id = $1 and m.company_id = $2 for update of m`, [matchId, company.id]);
  if (!m) throw new HttpError(404, 'That match does not exist.');
  if (m.status !== 'suggested') throw new HttpError(409, `This match was already ${m.status}.`);
  await c.query('update payment_matches set status = $2, decided_by = $3, decided_at = now() where id = $1', [m.id, confirm ? 'confirmed' : 'rejected', user.id]);
  const pay = `the payment of ${fmtMoney(m.amount, m.currency)} on ${m.booking_date || 'an unknown date'} (statement ${refOf(company, { seq: m.statement_seq })}, line ${m.line})`;
  const inv = `invoice ${m.invoice_number || m.title}`;
  await appendEvent(c, { companyId: company.id, itemId: m.invoice_item_id, actor: actorOf(user), type: confirm ? 'payment_confirmed' : 'payment_rejected',
    text: confirm ? `${actorOf(user).name} confirmed that ${pay} pays ${inv}` : `${actorOf(user).name} marked ${pay} as not related to ${inv}`,
    data: { match_id: m.id, transaction_id: m.transaction_id } });
}
