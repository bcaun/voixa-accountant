// Sample files in each country's formats, built the way banks and invoicing systems produce them.
import { deflateSync } from 'node:zlib';

/* ---------- Italy: FatturaPA ---------- */
export const fatturaPA = (number = '2026/145', total = '1220.00') => `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader>
    <DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>00743110157</IdCodice></IdTrasmittente><ProgressivoInvio>00001</ProgressivoInvio><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>0000000</CodiceDestinatario></DatiTrasmissione>
    <CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>00743110157</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Rossi Forniture S.r.l.</Denominazione></Anagrafica><RegimeFiscale>RF01</RegimeFiscale></DatiAnagrafici></CedentePrestatore>
    <CessionarioCommittente><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>01234567897</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Trattoria Bella Vista S.r.l.</Denominazione></Anagrafica></DatiAnagrafici></CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-10-01</Data><Numero>${number}</Numero><ImportoTotaleDocumento>${total}</ImportoTotaleDocumento></DatiGeneraliDocumento>
      <DatiContratto><IdDocumento>CTR-88</IdDocumento></DatiContratto>
    </DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Olio extravergine</Descrizione><PrezzoUnitario>1000.00</PrezzoUnitario><PrezzoTotale>1000.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>1000.00</ImponibileImporto><Imposta>220.00</Imposta></DatiRiepilogo>
    </DatiBeniServizi>
    <DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-10-31</DataScadenzaPagamento><ImportoPagamento>${total}</ImportoPagamento></DettaglioPagamento></DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;

/** A CAdES-signed .p7m around the XML, with the content split into 1000-byte chunks (BER, indefinite lengths), as signing tools do. */
export function p7m(xml) {
  const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
  const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
  const indef = (tag, ...parts) => Buffer.concat([Buffer.from([tag, 0x80]), ...parts, Buffer.from([0, 0])]);
  const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
  const data = Buffer.from(xml, 'utf8');
  const chunks = [];
  for (let i = 0; i < data.length; i += 1000) chunks.push(tlv(0x04, data.subarray(i, i + 1000)));
  const content = indef(0x30, oid('2a864886f70d010701'), indef(0xa0, indef(0x24, ...chunks)));
  const fakeCert = tlv(0x30, Buffer.concat([tlv(0x04, Buffer.from('0123456789abcdef', 'hex')), tlv(0x13, Buffer.from('Firma Test'))]));
  const signedData = indef(0x30, tlv(0x02, Buffer.from([1])), tlv(0x31, Buffer.alloc(0)), content, indef(0xa0, fakeCert), tlv(0x31, Buffer.alloc(0)));
  return indef(0x30, oid('2a864886f70d010702'), indef(0xa0, signedData));
}

/* ---------- Germany / EU: UBL (XRechnung) and CII (ZUGFeRD / Factur-X) ---------- */
export const ubl = `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>RE-2026-0042</cbc:ID><cbc:IssueDate>2026-10-02</cbc:IssueDate><cbc:DueDate>2026-10-16</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:ContractDocumentReference><cbc:ID>V-2024-7</cbc:ID></cac:ContractDocumentReference>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Müller Bürobedarf</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>DE136695976</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Müller Bürobedarf GmbH</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>DE811907980</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Bäckerei Schmidt GmbH</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">1190.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">1190.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
</ubl:Invoice>`;

export const cii = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument><ram:ID>FA-2026-0091</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20261003</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty><ram:Name>Dupont Fournitures SARL</ram:Name><ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">303265045</ram:ID></ram:SpecifiedLegalOrganization><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">FR40303265045</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>Boulangerie Martin SAS</ram:Name><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">FR44732829320</ram:ID></ram:SpecifiedTaxRegistration></ram:BuyerTradeParty>
      <ram:BuyerOrderReferencedDocument><ram:IssuerAssignedID>BC-551</ram:IssuerAssignedID></ram:BuyerOrderReferencedDocument>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">20261102</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>500.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount>500.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">100.00</ram:TaxTotalAmount><ram:GrandTotalAmount>600.00</ram:GrandTotalAmount><ram:DuePayableAmount>600.00</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

/** A minimal PDF/A-3 with the CII XML attached as a compressed embedded file, as Factur-X / ZUGFeRD tools produce. */
export function facturX(xml = cii) {
  const z = deflateSync(Buffer.from(xml, 'utf8'));
  const page = deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Facture FA-2026-0091) Tj ET'));
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(factur-x.xml) 5 0 R] >> >> >>\nendobj\n', 'latin1'),
    Buffer.from(`4 0 obj\n<< /Length ${page.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), page, Buffer.from('\nendstream\nendobj\n', 'latin1'),
    Buffer.from(`6 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
}

/* ---------- France: CFONB 120 ---------- */
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const amt = (cents) => {
  const neg = cents < 0, a = String(Math.abs(cents)).padStart(14, '0');
  const last = Number(a[13]);
  return a.slice(0, 13) + (neg ? '}JKLMNOPQR' : '{ABCDEFGHI')[last];
};
const rec = (code, date, label, cents, ref = '') =>
  pad(code + '30004' + '    ' + '00123' + 'EUR' + '2' + ' ' + '00012345678' + '  ' + date + '  ' + date + pad(label, 31) + '  ' + '0000001' + ' ' + ' ' + amt(cents) + pad(ref, 16), 120);
const rec05 = (qual, info) => pad('05' + '30004' + '    ' + '00123' + 'EUR' + '2' + ' ' + '00012345678' + '  ' + '031026' + '     ' + qual + pad(info, 70), 120);
export const cfonb120 = [
  rec('01', '300926', '', 1000000),
  rec('04', '031026', 'VIR SEPA DUPONT FOURNITURES', -60000, 'REF0091'),
  rec05('LIB', 'FACTURE FA-2026-0091'),
  rec05('NBE', 'DUPONT FOURNITURES SARL'),
  rec('04', '051026', 'VIR SEPA RECU CLIENT DURAND', 25000),
  rec('07', '311026', '', 965000),
].join('\r\n');

/* ---------- Germany: MT940 ---------- */
export const mt940 = `:20:STARTUMSE
:25:DE89370400440532013000
:28C:00010/001
:60F:C261001EUR10000,00
:61:2610031003D1190,00NMSCNONREF
:86:177?00SEPA-UEBERWEISUNG?20SVWZ+RECHNUNG RE-2026-0042?21 KUNDENNR 778?30COBADEFFXXX?31DE44500105175407324931?32MUELLER BUEROBEDARF GMBH
:61:2610051005C2380,00NMSCNONREF
:86:166?00GUTSCHRIFT?20SVWZ+RE 2026-0050 DANKE?32KUNDE AG
:62F:C261031EUR11190,00
-`;
