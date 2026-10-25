// Shared test data.
// Norma 43 records are fixed width; build them field by field so positions are explicit.
const pad = (s, n, c = ' ') => String(s).padEnd(n, c).slice(0, n);
const num = (v, n) => String(Math.round(Math.abs(v) * 100)).padStart(n, '0');
export const n43 = {
  header: (start, end, opening) => `11${'0182'}${'2741'}${'0201234567'}${start}${end}${opening < 0 ? '1' : '2'}${num(opening, 14)}9783${pad('SOL Y MAR HOSPITALITY', 26)}${pad('', 3)}`,
  move: (op, val, amount, ref1, ref2) => `22${'    '}${'2741'}${op}${val}${'02'}${'099'}${amount < 0 ? '1' : '2'}${num(amount, 14)}${'0000000000'}${pad(ref1, 12)}${pad(ref2, 16)}`,
  concept: (a, b = '') => `23${'01'}${pad(a, 38)}${pad(b, 38)}`,
  totals: (debits, credits, closing) => `33${'0182'}${'2741'}${'0201234567'}${'00001'}${num(debits, 14)}${'00001'}${num(credits, 14)}${closing < 0 ? '1' : '2'}${num(closing, 14)}978${pad('', 4)}`,
  end: () => `88${'9'.repeat(18)}${'000005'}${pad('', 54)}`,
};

export const SAMPLE_N43 = [
  n43.header('260901', '260930', 10000),
  n43.move('260912', '260912', -1210, 'MAKRO', ''),
  n43.concept('TRANSF. A FAVOR DE MAKRO AUTOSERV', 'FRA F-2026-08812 NIF A28647451'),
  n43.move('260915', '260915', 2420, '', ''),
  n43.concept('TRANSF RECIBIDA DE HOTEL BRISA SL', 'CONTRATO CT-2025-014 FACTURA 2026/0031'),
  n43.totals(1210, 2420, 11210),
  n43.end(),
].join('\r\n');
