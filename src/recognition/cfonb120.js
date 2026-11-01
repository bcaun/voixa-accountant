// CFONB 120 ("relevé de compte 120 caractères"): the fixed-width statement format of French banks.
// Records: 01 opening balance, 04 movement, 05 extra text for the movement above, 07 closing balance.
// Amounts are 14 characters; the last one carries both the last digit and the sign
// ({ A–I = 0–9 positive, } J–R = 0–9 negative), and position 20 gives the number of decimals.

const POS = '{ABCDEFGHI', NEG = '}JKLMNOPQR';

function amount(field, decimals) {
  const f = field.trim();
  if (!f) return null;
  const last = f[f.length - 1];
  let sign = 1, digit = last;
  if (POS.includes(last)) digit = String(POS.indexOf(last));
  else if (NEG.includes(last)) { digit = String(NEG.indexOf(last)); sign = -1; }
  const n = Number(f.slice(0, -1) + digit);
  if (!Number.isFinite(n)) return null;
  return sign * n / 10 ** (Number(decimals) || 0);
}
const date = (s) => (/^\d{6}$/.test(s) ? `20${s.slice(4, 6)}-${s.slice(2, 4)}-${s.slice(0, 2)}` : null);
const CURRENCY = { EUR: 'EUR', USD: 'USD', GBP: 'GBP', CHF: 'CHF' };

// some banks send the records back to back without line breaks
const records = (text) => {
  const t = text.replace(/\r/g, '');
  if (!t.includes('\n') && t.length >= 240 && t.length % 120 === 0) return t.match(/.{120}/g);
  return t.split('\n');
};

export function looksLikeCfonb120(text) {
  const lines = records(text).filter((l) => l.trim());
  return lines.length >= 2 && /^01\d{5}/.test(lines[0]) && lines.some((l) => l.startsWith('04')) && lines.every((l) => /^0[1457]/.test(l) && l.length <= 122);
}

export function parseCfonb120(text) {
  let opening = null, closing = null, currency = 'EUR', account = null, bank = null, periodStart = null, periodEnd = null;
  const transactions = [];
  let tx = null;
  for (const raw of records(text)) {
    if (!raw.trim()) continue;
    const l = raw.padEnd(120);
    const rec = l.slice(0, 2);
    const dec = l[19];
    if (rec === '01') {
      bank = l.slice(2, 7); account = `${l.slice(2, 7)} ${l.slice(11, 16)} ${l.slice(21, 32).trim()}`;
      currency = CURRENCY[l.slice(16, 19)] || l.slice(16, 19).trim() || 'EUR';
      if (opening == null) opening = amount(l.slice(90, 104), dec);
      periodStart ??= date(l.slice(34, 40));
    } else if (rec === '04') {
      tx = {
        booking_date: date(l.slice(34, 40)), value_date: date(l.slice(42, 48)),
        amount: amount(l.slice(90, 104), dec), currency,
        purpose: [l.slice(48, 79).trim()], bank_reference: l.slice(104, 120).trim() || null,
        counterparty_name: null,
      };
      if (tx.amount != null) transactions.push(tx);
    } else if (rec === '05' && tx) {
      // complementary text; NPY = payer name, NBE = beneficiary name, LIB / LCC = more description
      const qual = l.slice(45, 48), info = l.slice(48, 118).trim();
      if ((qual === 'NPY' || qual === 'NBE') && info) tx.counterparty_name = info;
      else if (info) tx.purpose.push(info);
    } else if (rec === '07') {
      closing = amount(l.slice(90, 104), dec);
      periodEnd = date(l.slice(34, 40));
    }
  }
  if (!transactions.length && opening == null) throw new Error('No CFONB 120 records found');
  return {
    bank_name: null, bank_code: bank, account_holder: null, iban: null, account_number: account, currency,
    period_start: periodStart || transactions[0]?.booking_date || null, period_end: periodEnd || transactions[transactions.length - 1]?.booking_date || null,
    opening_balance: opening, closing_balance: closing,
    transactions: transactions.map((t) => ({ ...t, purpose: t.purpose.filter(Boolean).join(' ') })),
  };
}
