// Bank CSV exports. Column names differ from bank to bank and between Spanish
// and English, so columns are found by name and numbers and dates are read in
// both "1.234,56 / 31/12/2026" and "1,234.56 / 2026-12-31" styles.

const COLS = {
  date: ['fecha', 'fecha operacion', 'fecha operación', 'f. operacion', 'f. operación', 'fecha contable', 'f. contable', 'date', 'booking date', 'transaction date', 'posting date', 'datum'],
  value_date: ['fecha valor', 'f. valor', 'value date', 'valuta'],
  purpose: ['concepto', 'descripcion', 'descripción', 'description', 'details', 'movimiento', 'concept', 'detalle', 'observaciones', 'narrative', 'memo', 'reference', 'referencia', 'remittance information', 'purpose'],
  amount: ['importe', 'amount', 'cantidad', 'importe eur', 'importe (eur)', 'betrag'],
  debit: ['cargo', 'cargos', 'debe', 'debit', 'debito', 'débito', 'withdrawal', 'withdrawals', 'paid out', 'money out'],
  credit: ['abono', 'abonos', 'haber', 'credit', 'credito', 'crédito', 'deposit', 'deposits', 'paid in', 'money in'],
  currency: ['divisa', 'moneda', 'currency'],
  balance: ['saldo', 'balance', 'saldo disponible'],
  counterparty: ['beneficiario', 'ordenante', 'contrapartida', 'counterparty', 'payee', 'payer', 'nombre', 'name', 'beneficiary'],
  counterparty_iban: ['iban contrapartida', 'cuenta contrapartida', 'counterparty iban', 'counterparty account', 'iban beneficiario', 'iban ordenante'],
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9. ()]/g, ' ').replace(/\s+/g, ' ').trim();

function splitLine(line, d) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseAmount(s) {
  let t = String(s ?? '').replace(/[€$£\s]|EUR|USD|GBP/gi, '');
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.endsWith('-')) { neg = true; t = t.slice(0, -1); }
  const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return neg ? -Math.abs(v) : v;
}

export function parseDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function findCol(headers, key) {
  const names = COLS[key].map(norm);
  let i = headers.findIndex((h) => names.includes(h));
  if (i < 0) i = headers.findIndex((h) => names.some((n) => n.length > 4 && h.startsWith(n)));
  return i;
}

export function looksLikeCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  return lines.length >= 2 && [';', ',', '\t'].some((d) => lines.filter((l) => l.split(d).length >= 3).length >= lines.length * 0.6);
}

export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const delim = [';', '\t', ','].map((d) => [d, lines.slice(0, 30).filter((l) => l.split(d).length >= 3).length]).sort((a, b) => b[1] - a[1])[0][0];
  // the header is the first row that has a date column and an amount (or debit/credit) column
  let h = -1, headers = [];
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const cells = splitLine(lines[i], delim).map(norm);
    if (findCol(cells, 'date') >= 0 && (findCol(cells, 'amount') >= 0 || findCol(cells, 'debit') >= 0 || findCol(cells, 'credit') >= 0)) { h = i; headers = cells; break; }
  }
  if (h < 0) throw new Error('Could not find the header row with a date and an amount column');
  const col = Object.fromEntries(Object.keys(COLS).map((k) => [k, findCol(headers, k)]));
  // the counterparty column must not be the same as the purpose column
  if (col.counterparty === col.purpose) col.counterparty = -1;
  const meta = lines.slice(0, h).join('\n');
  const transactions = [];
  for (const line of lines.slice(h + 1)) {
    if (!line.trim()) continue;
    const c = splitLine(line, delim);
    const booking = parseDate(c[col.date]);
    if (!booking) continue;
    let amount = col.amount >= 0 ? parseAmount(c[col.amount]) : null;
    if (amount == null) {
      const debit = col.debit >= 0 ? parseAmount(c[col.debit]) : null;
      const credit = col.credit >= 0 ? parseAmount(c[col.credit]) : null;
      if (debit) amount = -Math.abs(debit);
      else if (credit) amount = Math.abs(credit);
    }
    if (amount == null) continue;
    const purpose = col.purpose >= 0 ? c[col.purpose] : c.filter((x, i) => i !== col.date && i !== col.amount && i !== col.balance && isNaN(parseAmount(x) ?? NaN)).join(' ');
    transactions.push({
      booking_date: booking, value_date: col.value_date >= 0 ? parseDate(c[col.value_date]) : null, amount,
      currency: col.currency >= 0 ? (c[col.currency] || '').toUpperCase() || null : null,
      counterparty_name: col.counterparty >= 0 ? c[col.counterparty] || null : null,
      counterparty_iban: col.counterparty_iban >= 0 ? (c[col.counterparty_iban] || '').replace(/\s/g, '') || null : null,
      purpose: purpose || '', balance: col.balance >= 0 ? parseAmount(c[col.balance]) : null,
    });
  }
  if (!transactions.length) throw new Error('The file has a header row but no transactions could be read');
  const iban = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7})\b/.exec(meta.toUpperCase())?.[1]?.replace(/\s/g, '') || null;
  const dates = transactions.map((t) => t.booking_date).sort();
  const currency = /\b(EUR|USD|GBP|CHF)\b/.exec(meta.toUpperCase())?.[1] || transactions.find((t) => t.currency)?.currency || 'EUR';
  return {
    bank_name: null, account_holder: null, iban, currency,
    period_start: dates[0], period_end: dates[dates.length - 1],
    opening_balance: null, closing_balance: null,
    transactions: transactions.map((t) => ({ ...t, currency: t.currency || currency })),
  };
}
