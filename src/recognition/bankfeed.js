// Statements fetched through open banking are stored as JSON in this format (see src/bankfeeds.js).
export const looksLikeBankFeed = (text) => text.trimStart().startsWith('{') && text.includes('"pescada-bankfeed-1"');
export function parseBankFeed(text) {
  const d = JSON.parse(text);
  return { bank_name: d.bank, bank_code: null, account_holder: null, iban: d.iban, account_number: null, currency: d.currency,
    period_start: d.period_start, period_end: d.period_end, opening_balance: null, closing_balance: null,
    transactions: d.transactions.map(({ id, ...t }) => t) };
}
