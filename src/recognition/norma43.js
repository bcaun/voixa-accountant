// Norma 43 (AEB / CSB 43): the fixed-width statement format exported by Spanish banks.
// Records are 80 characters: 11 account header, 22 movement, 23 extra concept text,
// 24 currency equivalence, 33 account totals, 88 end of file.

const CURRENCY = { '978': 'EUR', '840': 'USD', '826': 'GBP', '756': 'CHF', '392': 'JPY', '752': 'SEK', '578': 'NOK', '208': 'DKK', '985': 'PLN', '203': 'CZK', '124': 'CAD' };
const date = (s) => (/^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : null);
const money = (s, sign) => (Number(s) / 100) * (sign === '1' ? -1 : 1);

export function looksLikeNorma43(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.length >= 2 && /^11\d{18}\d{12}/.test(lines[0]) && lines.some((l) => l.startsWith('22'));
}

export function parseNorma43(text) {
  const accounts = [];
  let acc = null;
  let tx = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.padEnd(80);
    const rec = l.slice(0, 2);
    if (rec === '11') {
      acc = {
        bank: l.slice(2, 6), branch: l.slice(6, 10), account: l.slice(10, 20),
        period_start: date(l.slice(20, 26)), period_end: date(l.slice(26, 32)),
        opening_balance: money(l.slice(33, 47), l[32]),
        currency: CURRENCY[l.slice(47, 50)] || l.slice(47, 50),
        holder: l.slice(51, 77).trim() || null, closing_balance: null, transactions: [],
      };
      accounts.push(acc);
    } else if (rec === '22' && acc) {
      tx = {
        booking_date: date(l.slice(10, 16)), value_date: date(l.slice(16, 22)),
        amount: money(l.slice(28, 42), l[27]), currency: acc.currency,
        bank_reference: [l.slice(42, 52), l.slice(52, 64)].map((s) => s.trim()).filter((s) => s && !/^0+$/.test(s)).join(' ') || null,
        purpose: [l.slice(64, 80).trim()].filter(Boolean),
      };
      acc.transactions.push(tx);
    } else if (rec === '23' && tx) {
      tx.purpose.push(l.slice(4, 42).trim(), l.slice(42, 80).trim());
    } else if (rec === '33' && acc) {
      acc.closing_balance = money(l.slice(59, 73), l[58]);
    }
  }
  if (!accounts.length) throw new Error('No account header (record 11) found');
  // A file can hold several accounts; one statement item is one file, so merge them.
  const first = accounts[0];
  return {
    bank_name: null,
    bank_code: first.bank,
    account_holder: first.holder,
    iban: null,
    account_number: `${first.bank} ${first.branch} ${first.account}`,
    currency: first.currency,
    period_start: first.period_start,
    period_end: accounts[accounts.length - 1].period_end,
    opening_balance: first.opening_balance,
    closing_balance: accounts.length === 1 ? first.closing_balance : null,
    transactions: accounts.flatMap((a) => a.transactions).map((t) => ({ ...t, purpose: t.purpose.filter(Boolean).join(' ') })),
  };
}
