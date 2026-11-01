// National formats and tax IDs, without a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fatturaPA, p7m, ubl, cii, facturX, cfonb120, mt940 } from './fixtures-intl.js';
import { findEInvoice, parseEInvoice } from '../src/recognition/einvoice.js';
import { looksLikeCfonb120, parseCfonb120 } from '../src/recognition/cfonb120.js';
import { looksLikeMt940, parseMt940 } from '../src/recognition/mt940.js';
import { looksLikeNorma43 } from '../src/recognition/norma43.js';
import { extractRefs, guessCounterparty } from '../src/recognition/refs.js';
import { checkTaxId, sameTaxId } from '../src/countries.js';
import { dueAfter } from '../src/dates.js';

test('tax IDs of each country are validated with their check digits', () => {
  const ok = [['ES', 'B56781234'], ['IT', 'IT00743110157'], ['IT', 'RSSMRA85T10A562S'], ['FR', '732829320'], ['FR', 'FR40303265045'], ['FR', '73282932000074'],
    ['DE', 'DE136695976'], ['DE', '12/345/67890'], ['PT', '501964843'], ['PT', 'PT500100144']];
  for (const [c, v] of ok) assert.ok(checkTaxId(c, v).ok, `${c} ${v}`);
  const bad = [['IT', '00743110158'], ['FR', '732829321'], ['FR', 'FR41303265045'], ['DE', 'DE136695977'], ['PT', '501964844'], ['ES', '1234']];
  for (const [c, v] of bad) assert.ok(!checkTaxId(c, v).ok, `${c} ${v}`);
  assert.ok(sameTaxId('FR40303265045', '303265045'));
  assert.ok(sameTaxId('73282932000074', 'FR44732829320'));
  assert.ok(sameTaxId('IT00743110157', '00743110157'));
  assert.ok(!sameTaxId('DE136695976', 'DE811907980'));
});

test('payment text in five languages yields counterparties, invoice numbers and tax IDs', () => {
  const cases = [
    ['BONIFICO SEPA A FAVORE DI ROSSI FORNITURE SRL CAUSALE FATTURA N. 2026/145 P.IVA 00743110157', 'ROSSI FORNITURE SRL', '2026/145', '00743110157'],
    ['VIR SEPA RECU DE DUPONT SARL MOTIF FACTURE FA-2026-0091 FR40303265045', 'DUPONT SARL', 'FA-2026-0091', 'FR40303265045'],
    ['SEPA-UEBERWEISUNG AN MUELLER GMBH SVWZ RECHNUNG RE-2026-0042 DE136695976', 'MUELLER GMBH', 'RE-2026-0042', 'DE136695976'],
    ['TRF P/ SILVA E FILHOS LDA FATURA FT 2026/77 NIF 501964843', 'SILVA E FILHOS LDA', '2026/77', '501964843'],
    ['TRANSFERENCIA A FAVOR DE MAKRO SA CONCEPTO FRA F-2026-08812 B12345678', 'MAKRO SA', 'F-2026-08812', 'B12345678'],
  ];
  for (const [text, name, inv, tax] of cases) {
    assert.equal(guessCounterparty(text), name, text);
    const r = extractRefs(text);
    assert.ok(r.invoices.includes(inv), `${text} → ${r.invoices}`);
    assert.ok(r.taxIds.includes(tax), `${text} → ${r.taxIds}`);
  }
  // a long number without a label or a valid check digit is not a tax ID
  assert.deepEqual(extractRefs('ORDINE 12345678901 RIF 99999999999').taxIds, []);
});

test('e-invoices: FatturaPA (plain, signed, base64), UBL, CII and Factur-X', () => {
  const read = (buf, type) => { const f = findEInvoice(buf, type); assert.ok(f, type); return [f.format, parseEInvoice(f)]; };
  let [fmt, inv] = read(Buffer.from(fatturaPA()), 'text');
  assert.equal(fmt, 'fatturapa');
  assert.deepEqual([inv.invoice_number, inv.issuer_tax_id, inv.net_amount, inv.tax_amount, inv.total_amount, inv.due_date, inv.contract_number],
    ['2026/145', 'IT00743110157', 1000, 220, 1220, '2026-10-31', 'CTR-88']);
  const long = fatturaPA('2026/146').replace('<DettaglioLinee>', `<DettaglioLinee>${' '.repeat(3000)}`);
  assert.equal(read(p7m(long), 'binary')[1].invoice_number, '2026/146');
  assert.equal(read(Buffer.from(p7m(long).toString('base64')), 'text')[1].invoice_number, '2026/146');
  [fmt, inv] = read(Buffer.from(ubl), 'text');
  assert.deepEqual([fmt, inv.invoice_number, inv.issuer_name, inv.total_amount, inv.contract_number], ['ubl', 'RE-2026-0042', 'Müller Bürobedarf GmbH', 1190, 'V-2024-7']);
  [fmt, inv] = read(Buffer.from(cii), 'text');
  assert.deepEqual([fmt, inv.invoice_number, inv.issue_date, inv.tax_amount, inv.total_amount], ['cii', 'FA-2026-0091', '2026-10-03', 100, 600]);
  [fmt, inv] = read(facturX(), 'pdf');
  assert.deepEqual([fmt, inv.invoice_number, inv.issuer_tax_id], ['facturx', 'FA-2026-0091', 'FR40303265045']);
  assert.equal(findEInvoice(Buffer.from('%PDF-1.4 plain scan'), 'pdf'), null);
});

test('bank statements: CFONB 120 and MT940 add up to their closing balance', () => {
  assert.ok(looksLikeCfonb120(cfonb120) && !looksLikeNorma43(cfonb120) && !looksLikeMt940(cfonb120));
  const fr = parseCfonb120(cfonb120);
  assert.equal(fr.transactions.length, 2);
  assert.deepEqual([fr.transactions[0].amount, fr.transactions[0].counterparty_name], [-600, 'DUPONT FOURNITURES SARL']);
  assert.equal(fr.opening_balance + fr.transactions.reduce((a, t) => a + t.amount, 0), fr.closing_balance);
  // records back to back without line breaks
  assert.equal(parseCfonb120(cfonb120.replace(/\r\n/g, '')).transactions.length, 2);
  assert.ok(looksLikeMt940(mt940));
  const de = parseMt940(mt940);
  assert.equal(de.iban, 'DE89370400440532013000');
  assert.deepEqual(de.transactions.map((t) => t.amount), [-1190, 2380]);
  assert.equal(de.transactions[0].counterparty_iban, 'DE44500105175407324931');
  assert.equal(de.opening_balance + de.transactions.reduce((a, t) => a + t.amount, 0), de.closing_balance);
});

test('deadline months: following month, second month after the quarter, and yearly', () => {
  const at = (ob, from, tz) => dueAfter(ob, new Date(from), tz).due.toISOString();
  assert.equal(at({ frequency: 'monthly', due_day: 16 }, '2026-11-01T00:00:00Z', 'Europe/Rome'), '2026-11-16T22:59:59.000Z');
  assert.equal(at({ frequency: 'quarterly', due_day: 20, month_offset: 2 }, '2026-11-21T00:00:00Z', 'Europe/Lisbon'), '2027-02-20T23:59:59.000Z');
  assert.equal(at({ frequency: 'quarterly', due_day: 10 }, '2026-11-01T00:00:00Z', 'Europe/Berlin'), '2027-01-10T22:59:59.000Z');
  assert.equal(at({ frequency: 'yearly', due_day: 31, due_month: 10 }, '2026-10-01T00:00:00Z', 'Europe/Rome'), '2026-10-31T22:59:59.000Z');
  assert.equal(at({ frequency: 'monthly', due_day: 31 }, '2027-02-01T00:00:00Z', 'Europe/Paris'), '2027-02-28T22:59:59.000Z');
});
