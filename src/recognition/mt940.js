// SWIFT MT940 customer statements, still the usual download from German banks (and common elsewhere).
// :25: account, :28C: statement number, :60F:/:60M: opening balance, :61: movement, :86: its details,
// :62F:/:62M: closing balance. German banks structure :86: with ?NN subfields
// (?20–?29 and ?60–?63 purpose, ?32/?33 counterparty name, ?31 counterparty IBAN, ?30 its BIC).

const dateYmd = (s) => (/^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : null);
const money = (s) => Number(String(s).replace(',', '.'));

export function looksLikeMt940(text) {
  return /:20:/.test(text) && /:25:/.test(text) && /:6[02][FM]:/.test(text) && /:61:/.test(text);
}

/** Split into tags; a tag's value runs until the next line that starts with :NN(X): */
function tags(text) {
  const out = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) out.push({ tag: m[1], value: m[2] });
    else if (out.length && line !== '-' && !/^\{|^-\}/.test(line)) out[out.length - 1].value += `\n${line}`;
  }
  return out;
}

function balance(v) {
  const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(v.trim());
  return m ? { amount: money(m[4]) * (m[1] === 'D' ? -1 : 1), date: dateYmd(m[2]), currency: m[3] } : null;
}

function details86(v) {
  const flat = v.replace(/\n/g, '');
  if (!/\?\d\d/.test(flat)) return { purpose: v.replace(/\n/g, ' ').trim(), name: null, iban: null };
  const fields = {};
  for (const m of flat.matchAll(/\?(\d\d)([^?]*)/g)) (fields[m[1]] ||= []).push(m[2]);
  const pick = (keys) => keys.flatMap((k) => fields[k] || []).join('');
  const purposeKeys = ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '60', '61', '62', '63'];
  let purpose = purposeKeys.flatMap((k) => fields[k] || []).join('');
  // SEPA keywords (SVWZ+ is the free text, EREF+ the end-to-end reference) are kept but separated
  purpose = purpose.replace(/(EREF|KREF|MREF|CRED|DEBT|SVWZ|ABWA|ABWE|IBAN|BIC)\+/g, ' $1+').trim();
  const booking = (fields['00'] || []).join('').trim();
  return { purpose: [booking, purpose].filter(Boolean).join(' '), name: pick(['32', '33']).trim() || null, iban: pick(['31']).trim() || null };
}

export function parseMt940(text) {
  const all = tags(text);
  if (!all.some((t) => t.tag === '61')) throw new Error('No :61: statement lines found');
  let account = null, opening = null, closing = null, currency = null;
  const transactions = [];
  for (let i = 0; i < all.length; i++) {
    const { tag, value } = all[i];
    if (tag === '25') account ??= value.trim();
    else if ((tag === '60F' || tag === '60M') && !opening) { opening = balance(value); currency ??= opening?.currency; }
    else if (tag === '62F' || tag === '62M') { closing = balance(value); currency ??= closing?.currency; }
    else if (tag === '61') {
      // YYMMDD [MMDD] [R]C|D [funds code] amount N|F|S + type code, reference [//bank reference] [\n supplementary]
      const [line, ...rest] = value.split('\n');
      const m = /^(\d{6})(\d{4})?(R?[CD])([A-Z])?([\d,]+)([NFS][A-Z0-9]{3})?([^/]*)(?:\/\/(.*))?$/.exec(line.trim());
      if (!m) continue;
      const debit = m[3] === 'D' || m[3] === 'RC';
      const value_date = dateYmd(m[1]);
      let booking_date = value_date;
      if (m[2]) {
        // the booking date has no year: take the value date's, adjusted around new year
        const y = Number(m[1].slice(0, 2)), vm = Number(m[1].slice(2, 4)), bm = Number(m[2].slice(0, 2));
        const by = bm === 12 && vm === 1 ? y - 1 : bm === 1 && vm === 12 ? y + 1 : y;
        booking_date = `20${String(by).padStart(2, '0')}-${m[2].slice(0, 2)}-${m[2].slice(2, 4)}`;
      }
      const next = all[i + 1]?.tag === '86' ? details86(all[i + 1].value) : { purpose: '', name: null, iban: null };
      const ref = (m[7] || '').trim();
      transactions.push({
        booking_date, value_date, amount: money(m[5]) * (debit ? -1 : 1),
        purpose: [next.purpose, rest.join(' ').trim()].filter(Boolean).join(' ') || ref,
        counterparty_name: next.name, counterparty_iban: next.iban,
        bank_reference: [ref && ref !== 'NONREF' ? ref : null, (m[8] || '').trim() || null].filter(Boolean).join(' ') || null,
      });
    }
  }
  const iban = /^([A-Z]{2}\d{2}[A-Z0-9]{10,30})$/.exec((account || '').replace(/\s/g, ''))?.[1] || null;
  const dates = transactions.map((t) => t.booking_date).filter(Boolean).sort();
  return {
    bank_name: null, account_holder: null, iban, account_number: iban ? null : account, currency: currency || 'EUR',
    period_start: opening?.date || dates[0] || null, period_end: closing?.date || dates[dates.length - 1] || null,
    opening_balance: opening?.amount ?? null, closing_balance: closing?.amount ?? null,
    transactions: transactions.map((t) => ({ ...t, currency: currency || 'EUR' })),
  };
}
