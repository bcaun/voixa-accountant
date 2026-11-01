// Exports for accounting software, built from what Pescada has read and the accountant has confirmed.
//   invoices: one row per recognised invoice, with the payment that was confirmed for it
//   bank:     one row per bank movement, with the invoice it was confirmed to pay
//   datev:    DATEV "Buchungsstapel" (EXTF 700, format version 13) for German clients, one booking
//             per confirmed payment, bank account against the generic debtor/creditor account (beta:
//             check the accounts on a test client before importing for real)
// CSV follows the client's country: semicolons and decimal commas everywhere except where
// the convention is commas and points, so files open straight in a local spreadsheet.
import { query } from './db.js';
import { countryOf } from './countries.js';
import { refOf } from './items.js';

const LOCALE = { ES: 'es-ES', IT: 'it-IT', FR: 'fr-FR', DE: 'de-DE', PT: 'pt-PT' };
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const num = (n, cc) => (n == null ? '' : Number(n).toLocaleString(LOCALE[cc] || 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }));
const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : '');

const HEAD = {
  invoices: {
    en: ['ref', 'invoice_number', 'issue_date', 'due_date', 'direction', 'issuer', 'issuer_tax_id', 'recipient', 'recipient_tax_id', 'currency', 'net', 'tax', 'total', 'paid_on', 'paid_amount', 'payment_statement', 'file'],
    es: ['ref', 'numero_factura', 'fecha_emision', 'fecha_vencimiento', 'tipo', 'emisor', 'nif_emisor', 'receptor', 'nif_receptor', 'moneda', 'base_imponible', 'cuota_iva', 'total', 'fecha_pago', 'importe_pagado', 'extracto', 'archivo'],
    it: ['rif', 'numero_fattura', 'data_emissione', 'data_scadenza', 'tipo', 'cedente', 'piva_cedente', 'cessionario', 'piva_cessionario', 'valuta', 'imponibile', 'imposta', 'totale', 'data_pagamento', 'importo_pagato', 'estratto', 'file'],
    fr: ['ref', 'numero_facture', 'date_emission', 'date_echeance', 'sens', 'emetteur', 'id_fiscal_emetteur', 'destinataire', 'id_fiscal_destinataire', 'devise', 'montant_ht', 'tva', 'montant_ttc', 'date_paiement', 'montant_paye', 'releve', 'fichier'],
    de: ['ref', 'rechnungsnummer', 'rechnungsdatum', 'faelligkeit', 'richtung', 'aussteller', 'ust_id_aussteller', 'empfaenger', 'ust_id_empfaenger', 'waehrung', 'netto', 'steuer', 'brutto', 'bezahlt_am', 'bezahlt_betrag', 'kontoauszug', 'datei'],
    pt: ['ref', 'numero_fatura', 'data_emissao', 'data_vencimento', 'tipo', 'emitente', 'nif_emitente', 'adquirente', 'nif_adquirente', 'moeda', 'base', 'iva', 'total', 'data_pagamento', 'valor_pago', 'extrato', 'ficheiro'],
  },
  bank: {
    en: ['statement', 'line', 'booking_date', 'value_date', 'amount', 'currency', 'counterparty', 'counterparty_tax_id', 'counterparty_iban', 'purpose', 'invoice_refs', 'matched_invoice', 'match_status'],
    es: ['extracto', 'linea', 'fecha', 'fecha_valor', 'importe', 'moneda', 'contraparte', 'nif_contraparte', 'iban_contraparte', 'concepto', 'refs_factura', 'factura_casada', 'estado'],
    it: ['estratto', 'riga', 'data', 'data_valuta', 'importo', 'valuta', 'controparte', 'piva_controparte', 'iban_controparte', 'causale', 'rif_fatture', 'fattura_abbinata', 'stato'],
    fr: ['releve', 'ligne', 'date', 'date_valeur', 'montant', 'devise', 'tiers', 'id_fiscal_tiers', 'iban_tiers', 'libelle', 'refs_facture', 'facture_rapprochee', 'statut'],
    de: ['auszug', 'zeile', 'buchungstag', 'wertstellung', 'betrag', 'waehrung', 'gegenpartei', 'ust_id_gegenpartei', 'iban_gegenpartei', 'verwendungszweck', 'rechnungsrefs', 'zugeordnete_rechnung', 'status'],
    pt: ['extrato', 'linha', 'data', 'data_valor', 'montante', 'moeda', 'contraparte', 'nif_contraparte', 'iban_contraparte', 'descritivo', 'refs_fatura', 'fatura_associada', 'estado'],
  },
};
const LANG = { ES: 'es', IT: 'it', FR: 'fr', DE: 'de', PT: 'pt' };

export async function accountingExport(company, { kind, from, to, lang, datev = {} }) {
  const cc = company.country;
  const L = lang || LANG[cc] || 'en';
  const sep = ';';
  const range = [from || '1900-01-01', to || '2999-12-31'];
  if (kind === 'invoices') {
    const { rows } = await query(
      `select d.*, i.seq, v.file_name, pm.status as match_status, t.booking_date as paid_on, t.amount as paid_amount, si.seq as statement_seq
       from invoice_data d join extractions e on e.id = d.extraction_id join items i on i.id = d.item_id
       join versions v on v.id = e.version_id and v.version = i.version
       left join payment_matches pm on pm.invoice_item_id = d.item_id and pm.status = 'confirmed'
       left join bank_transactions t on t.id = pm.transaction_id left join items si on si.id = t.item_id
       where d.company_id = $1 and coalesce(d.issue_date, v.uploaded_at::date) between $2 and $3 order by d.issue_date nulls last, i.seq`, [company.id, ...range]);
    const lines = [HEAD.invoices[L].join(sep), ...rows.map((d) => [refOf(company, d), d.invoice_number, day(d.issue_date), day(d.due_date), d.direction, d.issuer_name, d.issuer_tax_id,
      d.recipient_name, d.recipient_tax_id, d.currency, num(d.net_amount, cc), num(d.tax_amount, cc), num(d.total_amount, cc), day(d.paid_on), num(d.paid_amount, cc),
      d.statement_seq ? refOf(company, { seq: d.statement_seq }) : '', d.file_name].map(cell).join(sep))];
    return { filename: `pescada-${String(company.no).padStart(3, '0')}-invoices.csv`, type: 'text/csv; charset=utf-8', body: '﻿' + lines.join('\r\n') + '\r\n' };
  }
  if (kind === 'bank') {
    const { rows } = await query(
      `select t.*, i.seq as statement_seq, pm.status as match_status, d.invoice_number as matched_number
       from bank_transactions t join extractions e on e.id = t.extraction_id join items i on i.id = t.item_id
       join versions v on v.id = e.version_id and v.version = i.version
       left join lateral (select * from payment_matches m where m.transaction_id = t.id and m.status <> 'rejected' order by (m.status = 'confirmed') desc, m.score desc limit 1) pm on true
       left join invoice_data d on d.item_id = pm.invoice_item_id
       where t.company_id = $1 and coalesce(t.booking_date, t.value_date) between $2 and $3 order by t.booking_date nulls last, i.seq, t.line`, [company.id, ...range]);
    const lines = [HEAD.bank[L].join(sep), ...rows.map((t) => [refOf(company, { seq: t.statement_seq }), t.line, day(t.booking_date), day(t.value_date), num(t.amount, cc), t.currency,
      t.counterparty_name, t.counterparty_tax_id, t.counterparty_iban, t.purpose, (t.invoice_refs || []).join(' '), t.matched_number || '', t.match_status || ''].map(cell).join(sep))];
    return { filename: `pescada-${String(company.no).padStart(3, '0')}-bank.csv`, type: 'text/csv; charset=utf-8', body: '﻿' + lines.join('\r\n') + '\r\n' };
  }
  if (kind === 'datev') return datevExport(company, range, datev);
  throw Object.assign(new Error('Unknown export'), { status: 400 });
}

/**
 * DATEV Buchungsstapel. Each confirmed payment becomes one booking: the amount on the bank account
 * against the generic debtor (money in) or creditor (money out) account, with the invoice number
 * in Belegfeld 1. Defaults follow SKR03 (bank 1200, debtors 10000, creditors 70000).
 */
async function datevExport(company, [from, to], o) {
  const bank = String(o.bank || '1200'), debtor = String(o.debtor || '10000'), creditor = String(o.creditor || '70000');
  const len = Math.max(4, Math.min(8, Number(o.accountLength) || 4));
  const { rows } = await query(
    `select t.*, d.invoice_number, d.issue_date, d.issuer_name, d.recipient_name, d.direction
     from payment_matches pm join bank_transactions t on t.id = pm.transaction_id join invoice_data d on d.item_id = pm.invoice_item_id
     where pm.company_id = $1 and pm.status = 'confirmed' and t.booking_date between $2 and $3 order by t.booking_date, t.line`, [company.id, from, to]);
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const ymd = (d) => day(d).replace(/-/g, '');
  const dm = (d) => { const x = day(d); return x ? `${x.slice(8, 10)}${x.slice(5, 7)}` : ''; };
  const year = (rows[0]?.booking_date ? day(rows[0].booking_date) : from).slice(0, 4);
  const now = new Date();
  const stamp = `${now.toISOString().replace(/\D/g, '').slice(0, 17)}`;
  const header = ['"EXTF"', 700, 21, '"Buchungsstapel"', 13, stamp, '', '"RE"', '"Pescada"', '""', Number(o.consultant) || 1001, Number(o.client) || company.no,
    `${year}0101`, len, ymd(from) === '19000101' ? `${year}0101` : ymd(from), ymd(to) === '29991231' ? `${year}1231` : ymd(to), q(`Pescada ${company.name}`.slice(0, 30)), '""', 1, 0, 0, '"EUR"', '', '""', '', '', '""', '""', '', '', '""'];
  const cols = ['Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)',
    'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext'];
  const body = rows.map((t) => {
    const incoming = Number(t.amount) > 0;
    const party = incoming ? (t.recipient_name || t.counterparty_name) : (t.issuer_name || t.counterparty_name);
    return [num(Math.abs(t.amount), 'DE'), q(incoming ? 'S' : 'H'), q(t.currency || 'EUR'), '', '', '""', bank, incoming ? debtor : creditor, '""',
      dm(t.booking_date), q(String(t.invoice_number || '').replace(/[^A-Za-z0-9$&%*+\-/]/g, '').slice(0, 36)), '""', '', q(String(party || t.purpose || '').slice(0, 60))].join(';');
  });
  const text = [header.join(';'), cols.join(';'), ...body].join('\r\n') + '\r\n';
  // DATEV expects Windows-1252; the characters used here are all in Latin-1
  return { filename: `EXTF_Buchungsstapel_${company.no}_${year}.csv`, type: 'text/csv; charset=windows-1252', body: Buffer.from(text, 'latin1') };
}

export const exportKinds = (cc) => ['invoices', 'bank', ...(cc === 'DE' ? ['datev'] : [])];
export { countryOf };
