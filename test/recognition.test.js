// Unit tests for statement parsers, reference extraction and payment matching. No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNorma43, looksLikeNorma43 } from '../src/recognition/norma43.js';
import { parseCamt053, looksLikeCamt053 } from '../src/recognition/camt053.js';
import { parseCsv, parseAmount, parseDate } from '../src/recognition/csv.js';
import { extractRefs, sameRef, guessCounterparty, nameSimilarity } from '../src/recognition/refs.js';
import { scoreMatch, bestMatches } from '../src/recognition/matching.js';
import { costOf } from '../src/recognition/pricing.js';

import { SAMPLE_N43 } from './fixtures.js';

test('Norma 43: header, movements, concepts and balances', () => {
  assert.ok(looksLikeNorma43(SAMPLE_N43));
  for (const l of SAMPLE_N43.split('\r\n')) assert.equal(l.length, 80, `record "${l.slice(0, 2)}" is 80 characters`);
  const s = parseNorma43(SAMPLE_N43);
  assert.equal(s.currency, 'EUR');
  assert.equal(s.period_start, '2026-09-01');
  assert.equal(s.opening_balance, 10000);
  assert.equal(s.closing_balance, 11210);
  assert.equal(s.transactions.length, 2);
  assert.equal(s.transactions[0].amount, -1210);
  assert.equal(s.transactions[0].booking_date, '2026-09-12');
  assert.match(s.transactions[0].purpose, /FRA F-2026-08812/);
  assert.equal(s.transactions[1].amount, 2420);
});

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Acct><Id><IBAN>ES9121000418450200051332</IBAN></Id><Ccy>EUR</Ccy><Ownr><Nm>Sol y Mar Hospitality SL</Nm></Ownr><Svcr><FinInstnId><Nm>CaixaBank</Nm></FinInstnId></Svcr></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">5000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">4395.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<FrToDt><FrDtTm>2026-09-01T00:00:00</FrDtTm><ToDtTm>2026-09-30T23:59:59</ToDtTm></FrToDt>
<Ntry><Amt Ccy="EUR">605.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-20</Dt></BookgDt><ValDt><Dt>2026-09-20</Dt></ValDt>
<NtryDtls><TxDtls><Refs><EndToEndId>E2E-77</EndToEndId></Refs><RltdPties><Cdtr><Nm>Iberdrola Clientes SAU</Nm></Cdtr><CdtrAcct><Id><IBAN>ES7620770024003102575766</IBAN></Id></CdtrAcct></RltdPties>
<RmtInf><Ustrd>Factura 21000123456 contrato 0034-55</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

test('camt.053: account, balances, counterparty and remittance text', () => {
  assert.ok(looksLikeCamt053(CAMT));
  const s = parseCamt053(CAMT);
  assert.equal(s.iban, 'ES9121000418450200051332');
  assert.equal(s.bank_name, 'CaixaBank');
  assert.equal(s.opening_balance, 5000);
  assert.equal(s.closing_balance, 4395);
  const [t] = s.transactions;
  assert.equal(t.amount, -605);
  assert.equal(t.counterparty_name, 'Iberdrola Clientes SAU');
  assert.equal(t.counterparty_iban, 'ES7620770024003102575766');
  assert.equal(t.bank_reference, 'E2E-77');
  assert.match(t.purpose, /contrato 0034-55/);
});

test('CSV: Spanish bank export with separate debit and credit columns', () => {
  const csv = `Cuenta;ES12 0049 1500 0512 3456 7890\nMoneda;EUR\n\nFecha Operación;Fecha Valor;Concepto;Cargo;Abono;Saldo\n12/09/2026;12/09/2026;"TRANSF A MAKRO, FRA F-2026-08812";1.210,00;;8.790,00\n15/09/2026;15/09/2026;ABONO HOTEL BRISA FACT 2026/0031;;2.420,00;11.210,00\n`;
  const s = parseCsv(csv);
  assert.equal(s.iban, 'ES1200491500051234567890');
  assert.equal(s.transactions.length, 2);
  assert.deepEqual(s.transactions.map((t) => t.amount), [-1210, 2420]);
  assert.equal(s.transactions[0].booking_date, '2026-09-12');
});

test('CSV: English export with one signed amount column', () => {
  const s = parseCsv('Date,Description,Amount,Currency,Balance\n2026-09-03,"Invoice INV-00451 Acme Ltd","-1,250.50",GBP,"3,000.00"\n');
  assert.equal(s.transactions[0].amount, -1250.5);
  assert.equal(s.transactions[0].currency, 'GBP');
});

test('amounts and dates in both styles', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('-45,10 €'), -45.1);
  assert.equal(parseAmount('(99.00)'), -99);
  assert.equal(parseDate('05/11/2026'), '2026-11-05');
  assert.equal(parseDate('2026-11-05'), '2026-11-05');
});

test('references: invoice and contract numbers, NIF and IBAN from payment text', () => {
  const r = extractRefs('TRANSF A MAKRO FRA F-2026-08812 Y FACTURA Nº 2026/0031 CONTRATO CT-2025-014 NIF B56781234 IBAN ES76 2077 0024 0031 0257 5766');
  assert.ok(r.invoices.includes('F-2026-08812'));
  assert.ok(r.invoices.includes('2026/0031'));
  assert.deepEqual(r.contracts, ['CT-2025-014']);
  assert.ok(r.taxIds.includes('B56781234'));
  assert.deepEqual(r.ibans, ['ES7620770024003102575766']);
  assert.deepEqual(extractRefs('FACTURA DE LUZ SEPTIEMBRE').invoices, [], 'words after a label are not numbers');
});

test('invoice numbers compare across formatting', () => {
  assert.ok(sameRef('F-2026-08812', 'F2026/08812'));
  assert.ok(sameRef('2026/0031', 'FV-2026-0031'));
  assert.ok(!sameRef('2026/0031', '2026/0032'));
});

test('counterparty names from bank wording', () => {
  assert.equal(guessCounterparty('TRANSFERENCIA A FAVOR DE MAKRO AUTOSERVICIO MAYORISTA SA FRA F-1'), 'MAKRO AUTOSERVICIO MAYORISTA SA');
  assert.ok(nameSimilarity('MAKRO AUTOSERVICIO MAYORISTA SA', 'Makro Autoservicio Mayorista, S.A.U.') >= 0.6);
});

const invoice = { item_id: 'inv1', invoice_number: 'F-2026-08812', total_amount: 1210, currency: 'EUR', issue_date: '2026-09-01',
  issuer_name: 'Makro Autoservicio Mayorista SA', issuer_tax_id: 'A28647451', recipient_name: 'Sol y Mar Hospitality SL', direction: 'received' };

test('matching: number + amount + name is a strong match', () => {
  const tx = { amount: -1210, currency: 'EUR', booking_date: '2026-09-12', counterparty_name: 'MAKRO AUTOSERV', purpose: 'TRANSFERENCIA A FAVOR DE MAKRO AUTOSERV FRA F-2026-08812', invoice_refs: ['F-2026-08812'] };
  const m = scoreMatch(tx, invoice);
  assert.ok(m.score >= 90, `score ${m.score}`);
  assert.ok(m.reasons.includes('same amount'));
});

test('matching: amount and supplier without a number still matches; wrong direction does not', () => {
  const tx = { amount: -1210, currency: 'EUR', booking_date: '2026-09-12', counterparty_name: 'Makro Autoservicio', purpose: 'PAGO PROVEEDOR', invoice_refs: [] };
  assert.ok(scoreMatch(tx, invoice).score >= 50);
  assert.ok(scoreMatch({ ...tx, amount: 1210 }, invoice).score < 50);
  assert.equal(bestMatches({ ...tx, counterparty_name: 'Other company', amount: -99 }, [invoice]).length, 0);
});

test('cost of a call from its token usage', () => {
  const round = (n) => Math.round(n * 1e6) / 1e6;
  assert.equal(round(costOf({ input_tokens: 8000, output_tokens: 5000 }, 'claude-opus-5-5').cost), 0.132);
  // cache reads are billed at the cache price, cache writes at 1.25x input
  assert.equal(round(costOf({ input_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000, output_tokens: 0 }, 'claude-opus-5-5').cost), 0.007);
  // a fallback after a decline: each part is priced at the model that produced it
  const fb = costOf({ input_tokens: 2000, output_tokens: 600, iterations: [
    { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100 },
    { type: 'fallback_message', model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 500 }] }, 'claude-opus-5-5');
  assert.equal(round(fb.cost), round((1000 * 4 + 100 * 20 + 1000 * 2 + 500 * 10) / 1e6));
  // Haiku 5.5 prompts over 100K tokens use the higher tier
  assert.equal(round(costOf({ input_tokens: 200000, output_tokens: 1000 }, 'claude-haiku-5-5').cost), round((200000 * 0.5 + 1000 * 2.5) / 1e6));
  assert.equal(costOf({ input_tokens: 1 }, 'some-unknown-model').known, false);
});
