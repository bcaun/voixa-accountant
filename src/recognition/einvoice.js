// Structured e-invoices, read exactly by code instead of by the AI reader:
//   FatturaPA (Italy, through SdI), as .xml or signed .xml.p7m
//   UBL 2.1 Invoice / CreditNote (PEPPOL, XRechnung, Portugal and France B2G)
//   UN/CEFACT CII (XRechnung, Factur-X, ZUGFeRD), on its own or embedded in a PDF/A-3
// The result has the same fields as the AI reader's invoice schema.
import { inflateSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

export const EINVOICE_LABEL = {
  fatturapa: 'FatturaPA e-invoice', ubl: 'UBL e-invoice', cii: 'CII e-invoice', facturx: 'Factur-X / ZUGFeRD invoice embedded in the PDF',
};

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v == null ? null : typeof v === 'object' ? (v['#text'] != null ? String(v['#text']) : null) : String(v));
const num = (v) => { const t = text(v); if (t == null || t.trim() === '') return null; const n = Number(t.trim()); return Number.isFinite(n) ? n : null; };
const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const parser = () => new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true });

const detect = (xml) => {
  const head = xml.slice(0, 4000);
  if (/FatturaElettronica[\s>]/.test(head)) return 'fatturapa';
  if (/CrossIndustryInvoice[\s>]/.test(head)) return 'cii';
  if (/<(?:\w+:)?(?:Invoice|CreditNote)[\s>]/.test(head) && /oasis-open|urn:oasis:names:specification:ubl/i.test(head)) return 'ubl';
  return null;
};

/**
 * Look for an e-invoice in a file: a plain XML, a signed FatturaPA (.p7m, binary or base64),
 * or an XML attached inside a PDF (Factur-X, ZUGFeRD, XRechnung hybrid). Returns { format, xml } or null.
 */
export function findEInvoice(buf, type) {
  if (type === 'text') {
    const s = buf.toString('utf8').replace(/^﻿/, '');
    const f = detect(s);
    if (f) return { format: f, xml: s };
    // a .p7m sent as base64 text
    if (/^[A-Za-z0-9+/=\r\n]{200,}$/.test(s.trim())) {
      const inner = fromP7m(Buffer.from(s.replace(/\s/g, ''), 'base64'));
      if (inner) return { format: 'fatturapa', xml: inner };
    }
    return null;
  }
  if (type === 'pdf') {
    const xml = xmlInPdf(buf);
    if (xml) {
      const f = detect(xml);
      if (f === 'cii' || f === 'ubl') return { format: f === 'cii' ? 'facturx' : 'ubl', xml };
    }
    return null;
  }
  if (type === 'binary') {
    const inner = fromP7m(buf);
    if (inner) return { format: 'fatturapa', xml: inner };
  }
  return null;
}

export function parseEInvoice({ format, xml }) {
  if (format === 'fatturapa') return parseFatturaPA(xml);
  if (format === 'ubl') return parseUbl(xml);
  return parseCii(xml);
}

/* ---------- signed FatturaPA (CAdES .p7m) ---------- */

/**
 * The signed file is DER/BER PKCS#7 SignedData. The XML is the encapsulated content: one OCTET STRING,
 * or several when the signer split it into chunks. Collect the octet strings in order and cut out the XML.
 */
export function fromP7m(buf) {
  if (!buf || buf.length < 32 || buf[0] !== 0x30) return null;
  const parts = [];
  const walk = (start, end, depth) => {
    let i = start;
    while (i < end && depth < 40) {
      const tag = buf[i++];
      if (tag === 0x00 && buf[i] === 0x00) { i++; return i; } // end of indefinite length
      let len = buf[i++];
      let indefinite = false;
      if (len === 0x80) indefinite = true;
      else if (len & 0x80) {
        const n = len & 0x7f;
        if (n > 4) return end;
        len = 0;
        for (let k = 0; k < n; k++) len = len * 256 + buf[i++];
      }
      const constructed = (tag & 0x20) !== 0;
      if (constructed) {
        if (indefinite) i = walk(i, end, depth + 1);
        else { walk(i, Math.min(end, i + len), depth + 1); i += len; }
      } else {
        if (indefinite) return end;
        if ((tag & 0x1f) === 0x04) parts.push(buf.subarray(i, i + len));
        i += len;
      }
    }
    return i;
  };
  try { walk(0, buf.length, 0); } catch { return null; }
  const all = Buffer.concat(parts).toString('utf8');
  const start = all.search(/<\?xml|<(?:\w+:)?FatturaElettronica[\s>]/);
  const endTag = /<\/(?:\w+:)?FatturaElettronica>/.exec(all);
  if (start < 0 || !endTag) return null;
  return all.slice(start, endTag.index + endTag[0].length);
}

/* ---------- XML attached to a PDF ---------- */

/** Inflate each compressed stream of the PDF (invoices are small) and return the first one that is an e-invoice. */
export function xmlInPdf(buf) {
  const s = buf.toString('latin1');
  const re = /(?<!end)stream\r?\n/g;
  let m, tries = 0;
  while ((m = re.exec(s)) && tries < 400) {
    tries++;
    const dictStart = s.lastIndexOf('<<', m.index);
    const dict = s.slice(Math.max(dictStart, m.index - 600), m.index);
    const begin = m.index + m[0].length;
    const end = s.indexOf('endstream', begin);
    if (end < 0) break;
    re.lastIndex = end + 9;
    if (end - begin > 5e6) continue;
    let data = buf.subarray(begin, end);
    if (/\/FlateDecode/.test(dict)) {
      try { data = inflateSync(data); } catch { try { data = inflateSync(data.subarray(0, data.length - 1)); } catch { continue; } }
    } else if (/\/Filter/.test(dict)) continue;
    const head = data.subarray(0, 3000).toString('utf8');
    if (/CrossIndustryInvoice|urn:oasis:names:specification:ubl/.test(head)) return data.toString('utf8').replace(/^﻿/, '');
  }
  return null;
}

/* ---------- FatturaPA ---------- */

function partyFatturaPA(p) {
  const a = p?.DatiAnagrafici || {};
  const ana = a.Anagrafica || {};
  const name = clean(text(ana.Denominazione)) || clean([text(ana.Nome), text(ana.Cognome)].filter(Boolean).join(' '));
  const vat = a.IdFiscaleIVA ? `${text(a.IdFiscaleIVA.IdPaese) || ''}${text(a.IdFiscaleIVA.IdCodice) || ''}` : null;
  return { name, taxId: clean(vat) || clean(text(a.CodiceFiscale)) };
}

export function parseFatturaPA(xml) {
  const doc = parser().parse(xml);
  const root = doc.FatturaElettronica;
  if (!root) throw new Error('No FatturaElettronica element');
  const head = root.FatturaElettronicaHeader || {};
  const bodies = arr(root.FatturaElettronicaBody);
  if (!bodies.length) throw new Error('No invoice body');
  const seller = partyFatturaPA(head.CedentePrestatore);
  const buyer = partyFatturaPA(head.CessionarioCommittente);
  const one = (b) => {
    const g = b.DatiGenerali?.DatiGeneraliDocumento || {};
    const recap = arr(b.DatiBeniServizi?.DatiRiepilogo);
    const net = recap.length ? recap.reduce((a, r) => a + (num(r.ImponibileImporto) || 0), 0) : null;
    const tax = recap.length ? recap.reduce((a, r) => a + (num(r.Imposta) || 0), 0) : null;
    const pay = arr(b.DatiPagamento).flatMap((p) => arr(p.DettaglioPagamento));
    const contract = text(arr(b.DatiGenerali?.DatiContratto)[0]?.IdDocumento) || text(arr(b.DatiGenerali?.DatiOrdineAcquisto)[0]?.IdDocumento);
    const total = num(g.ImportoTotaleDocumento) ?? (net != null ? Math.round((net + (tax || 0)) * 100) / 100 : null);
    return {
      invoice_number: clean(text(g.Numero)), issue_date: text(g.Data)?.slice(0, 10) || null,
      due_date: text(pay.find((p) => p.DataScadenzaPagamento)?.DataScadenzaPagamento)?.slice(0, 10) || null,
      currency: text(g.Divisa) || 'EUR', net_amount: net, tax_amount: tax, total_amount: total,
      contract_number: clean(contract), document_type: { TD01: 'invoice', TD04: 'credit note', TD05: 'debit note', TD06: 'fee note' }[text(g.TipoDocumento)] || text(g.TipoDocumento),
    };
  };
  const first = one(bodies[0]);
  return {
    is_invoice: true, issuer_name: seller.name, issuer_tax_id: seller.taxId, recipient_name: buyer.name, recipient_tax_id: buyer.taxId,
    ...first,
    // a FatturaPA file can carry several invoices ("lotto"); the first is stored, the others are listed
    extra_invoices: bodies.length > 1 ? bodies.slice(1).map(one).map((b) => ({ number: b.invoice_number, total: b.total_amount })) : undefined,
  };
}

/* ---------- UBL 2.1 ---------- */

function partyUbl(p) {
  const party = p?.Party || {};
  const name = clean(text(arr(party.PartyLegalEntity)[0]?.RegistrationName)) || clean(text(arr(party.PartyName)[0]?.Name));
  const taxId = clean(text(arr(party.PartyTaxScheme)[0]?.CompanyID)) || clean(text(arr(party.PartyLegalEntity)[0]?.CompanyID)) || clean(text(party.EndpointID));
  return { name, taxId };
}

export function parseUbl(xml) {
  const doc = parser().parse(xml);
  const inv = doc.Invoice || doc.CreditNote;
  if (!inv) throw new Error('No Invoice or CreditNote element');
  const seller = partyUbl(inv.AccountingSupplierParty);
  const buyer = partyUbl(inv.AccountingCustomerParty);
  const totals = inv.LegalMonetaryTotal || {};
  const taxTotal = arr(inv.TaxTotal).map((t) => num(t.TaxAmount)).find((v) => v != null) ?? null;
  const net = num(totals.TaxExclusiveAmount);
  return {
    is_invoice: true,
    invoice_number: clean(text(inv.ID)), issue_date: text(inv.IssueDate)?.slice(0, 10) || null,
    due_date: text(inv.DueDate)?.slice(0, 10) || text(arr(inv.PaymentMeans)[0]?.PaymentDueDate)?.slice(0, 10) || null,
    issuer_name: seller.name, issuer_tax_id: seller.taxId, recipient_name: buyer.name, recipient_tax_id: buyer.taxId,
    currency: text(inv.DocumentCurrencyCode) || 'EUR',
    net_amount: net, tax_amount: taxTotal, total_amount: num(totals.TaxInclusiveAmount) ?? num(totals.PayableAmount),
    contract_number: clean(text(arr(inv.ContractDocumentReference)[0]?.ID)) || clean(text(inv.OrderReference?.ID)),
    document_type: doc.CreditNote ? 'credit note' : 'invoice',
  };
}

/* ---------- UN/CEFACT CII ---------- */

const ciiDate = (v) => {
  const t = text(v?.DateTimeString) || text(v);
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(t || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

function partyCii(p) {
  if (!p) return { name: null, taxId: null };
  const regs = arr(p.SpecifiedTaxRegistration).map((r) => ({ id: text(r.ID), scheme: r.ID?.['@schemeID'] }));
  const vat = regs.find((r) => r.scheme === 'VA')?.id || regs[0]?.id;
  return { name: clean(text(p.Name)), taxId: clean(vat) || clean(text(p.SpecifiedLegalOrganization?.ID)) };
}

export function parseCii(xml) {
  const doc = parser().parse(xml);
  const root = doc.CrossIndustryInvoice;
  if (!root) throw new Error('No CrossIndustryInvoice element');
  const ex = root.ExchangedDocument || {};
  const t = root.SupplyChainTradeTransaction || {};
  const agr = t.ApplicableHeaderTradeAgreement || {};
  const set = t.ApplicableHeaderTradeSettlement || {};
  const sum = set.SpecifiedTradeSettlementHeaderMonetarySummation || {};
  const currency = text(set.InvoiceCurrencyCode) || 'EUR';
  // TaxTotalAmount may be given twice (invoice currency and accounting currency)
  const taxes = arr(sum.TaxTotalAmount);
  const tax = num(taxes.find((x) => !x?.['@currencyID'] || x['@currencyID'] === currency) ?? taxes[0]);
  const seller = partyCii(agr.SellerTradeParty), buyer = partyCii(agr.BuyerTradeParty);
  return {
    is_invoice: true,
    invoice_number: clean(text(ex.ID)), issue_date: ciiDate(ex.IssueDateTime),
    due_date: ciiDate(arr(set.SpecifiedTradePaymentTerms)[0]?.DueDateDateTime),
    issuer_name: seller.name, issuer_tax_id: seller.taxId, recipient_name: buyer.name, recipient_tax_id: buyer.taxId,
    currency, net_amount: num(sum.TaxBasisTotalAmount), tax_amount: tax, total_amount: num(sum.GrandTotalAmount) ?? num(sum.DuePayableAmount),
    contract_number: clean(text(agr.ContractReferencedDocument?.IssuerAssignedID)) || clean(text(agr.BuyerOrderReferencedDocument?.IssuerAssignedID)),
    document_type: { 380: 'invoice', 381: 'credit note', 384: 'corrected invoice', 389: 'self-billed invoice' }[text(ex.TypeCode)] || text(ex.TypeCode),
  };
}
