// Pull references out of free payment text: invoice and contract numbers,
// tax IDs (Spain, Italy, France, Germany, Portugal) and IBANs. Used on every
// transaction whatever the source, and merged with what the AI reader returns.
// Bank wording is recognised in Spanish, Italian, French, German, Portuguese and English.
import { validCodiceFiscale, validFrenchVat, validGermanVat, validPartitaIva, validPortugueseNif, validSiren, validSiret } from '../countries.js';

const INVOICE_RE = /\b(?:N[º°O]\.?\s*)?(?:FACTURAS?|FACT|FRA|FRAS|FAC|FCT|INVOICES?|INV|RECIBO|REC|FATTURA|FATTURE|FATT|FT|FACTURE|FACTURES|RECHNUNGS?(?:NR|NUMMER)?|RG|RE|FATURAS?|FAT|FAT-REC)\b\.?\s*(?:N[º°O]\.?|NUM\.?|NR\.?|NO\.?|N\.|NUMERO|NUMÉRO|NUMMER|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\/\-.]{2,24})/gi;
const CONTRACT_RE = /\b(?:CONTRATOS?|CONTR|CTO|CONTRACT|AGREEMENT|P[OÓ]LIZA|POLICY|EXPEDIENTE|EXP|CONTRATTO|POLIZZA|CONTRAT|POLICE|VERTRAG(?:SNR|SNUMMER)?|VERTRAGS?-?NR|AP[OÓ]LICE)\b\.?\s*(?:N[º°O]\.?|NUM\.?|NR\.?|NO\.?|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\/\-.]{2,24})/gi;
// Codes that look like invoice numbers even without a label, e.g. F-2026-08812, FV26/0012, INV-00451
const BARE_INVOICE_RE = /\b((?:F|FV|FC|FA|FR|FRA|INV|SI|PI)[-\/]?\d{2,4}[-\/]\d{2,8})\b/gi;
const NIF_RE = /\b(?:ES)?([ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/g;
// Other countries' IDs are taken only with a VAT prefix or a label, or when their check digit is right,
// so that ordinary long numbers in payment text are not mistaken for them.
const VAT_RE = /\b(IT\d{11}|FR[0-9A-HJ-NP-Z]{2}\d{9}|DE\d{9}|PT\d{9})\b/g;
const LABELLED_RE = /\b(?:P\.?\s?IVA|PARTITA IVA|C\.?F\.?|COD(?:ICE)?\.?\s?FISC(?:ALE)?|SIREN|SIRET|NIPC|NIF|CONTRIBUINTE|USt-?Id(?:Nr)?\.?|STEUER-?NR\.?|STNR)\s*[:.]?\s*([A-Z0-9][A-Z0-9\/ ]{7,18}[A-Z0-9])/gi;
const CF_RE = /\b([A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z])\b/g;

function foreignTaxIds(upper) {
  const out = [];
  for (const m of upper.matchAll(VAT_RE)) {
    const v = m[1], cc = v.slice(0, 2), core = v.slice(2);
    if ((cc === 'IT' && validPartitaIva(core)) || (cc === 'FR' && validFrenchVat(v)) || (cc === 'DE' && validGermanVat(v)) || (cc === 'PT' && validPortugueseNif(core))) out.push(v);
  }
  for (const m of upper.matchAll(LABELLED_RE)) {
    const raw = m[1].trim();
    const v = raw.replace(/\s/g, '');
    if (validPartitaIva(v) || validCodiceFiscale(v) || validSiren(v) || validSiret(v) || validPortugueseNif(v)) out.push(v);
    else if (/^\d{2,3}\/\d{3,4}\/\d{4,5}$/.test(raw)) out.push(raw); // German Steuernummer as printed
  }
  for (const m of upper.matchAll(CF_RE)) if (validCodiceFiscale(m[1])) out.push(m[1]);
  return out;
}
const IBAN_RE = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?)\b/g;

const clean = (s) => s.replace(/[.\-\/]+$/, '').toUpperCase();
const uniq = (a) => [...new Set(a.filter(Boolean))];
// Words that follow a label but are not numbers ("FACTURA DE MAKRO", "CONTRATO ALQUILER")
const looksLikeRef = (s) => /\d/.test(s) && s.length >= 3;

export function extractRefs(text) {
  const t = String(text || '');
  const ibans = uniq([...t.toUpperCase().matchAll(IBAN_RE)].map((m) => m[1].replace(/\s/g, '')).filter((i) => i.length >= 15));
  const ibanSet = new Set(ibans);
  const notIban = (r) => !ibanSet.has(r.replace(/\s/g, ''));
  const invoices = uniq([...t.matchAll(INVOICE_RE), ...t.matchAll(BARE_INVOICE_RE)].map((m) => clean(m[1])).filter(looksLikeRef).filter(notIban));
  const contracts = uniq([...t.matchAll(CONTRACT_RE)].map((m) => clean(m[1])).filter(looksLikeRef).filter(notIban));
  const taxIds = uniq([...[...t.toUpperCase().matchAll(NIF_RE)].map((m) => m[1]), ...foreignTaxIds(t.toUpperCase())]);
  return { invoices, contracts, taxIds, ibans };
}

/** Normalise a document number for comparison: letters and digits only, upper case. */
export const normRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Do two invoice numbers refer to the same invoice? Tolerates prefixes and leading zeros. */
export function sameRef(a, b) {
  const x = normRef(a), y = normRef(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 5 && long.endsWith(short)) return true;
  const digits = (s) => s.replace(/\D/g, '').replace(/^0+/, '');
  const dx = digits(x), dy = digits(y);
  return dx.length >= 4 && dx === dy && x.replace(/\d/g, '').slice(0, 1) === y.replace(/\d/g, '').slice(0, 1);
}

const GENERIC = new Set(['PROVEEDOR', 'PROVEEDORES', 'NOMINA', 'NÓMINA', 'NOMINAS', 'IMPUESTOS', 'SEGUROS SOCIALES', 'CLIENTE', 'CLIENTES', 'TRANSFERENCIA', 'RECIBO', 'TARJETA',
  'FORNITORE', 'FORNITORI', 'STIPENDIO', 'STIPENDI', 'F24', 'FOURNISSEUR', 'SALAIRE', 'SALAIRES', 'URSSAF', 'LIEFERANT', 'GEHALT', 'LOHN', 'FINANZAMT', 'FORNECEDOR', 'SALARIO', 'SALÁRIO', 'ORDENADO']);

// Words that end a name in bank text: the reference or number part that follows it.
const NAME_END = String.raw`(?=\s+(?:CONCEPTO|CONCEPT|REF|REFERENCIA|FRA|FRAS|FACT|FACTURA|FACTURAS|INV|INVOICE|RECIBO|CONTRATO|CONTR|CTO|CONTRACT|P[OÓ]LIZA|POLICY|IBAN|[A-Z]{2}\d{2}|NIF|CIF|N[º°O]|TARJ|TARJETA|CAUSALE|FATTURA|FATT|FT|RIF|MOTIF|FACTURE|REFERENCE|RÉFÉRENCE|VERWENDUNGSZWECK|RECHNUNG|RE|SVWZ|EREF|MREF|KREF|DESCRITIVO|FATURA|VERTRAG|VERTRAGSNR|MANDAT|MANDATSREF|KUNDENNR|CONTRATTO|CONTRAT|P\.?\s?IVA|C\.?F\.?|\d{2}[\/.]\d{2})\b|$|\s{2}|,)`;
const NAME = "([A-ZÁÉÍÓÚÑÜÀÈÌÒÙÂÊÎÔÛÇÄÖẞÃÕ0-9&.,' -]{3,60}?)";

/** Guess the other party's name from Spanish and English bank wording. */
export function guessCounterparty(text) {
  const t = String(text || '').replace(/[ \t]+/g, ' ').trim();
  const patterns = [
    String.raw`(?:ORDENANTE|BENEFICIARIO|BENEF|PAYEE|PAYER|REMITENTE|DESTINATARIO)\s*[:.]?\s*`,
    String.raw`TRANSF(?:ERENCIA)?\.?\s*(?:SEPA\s*)?(?:A FAVOR DE|EMITIDA A|RECIBIDA DE|DE|A)\s+`,
    String.raw`(?:RECIBO|ADEUDO|DOMICILIACI[OÓ]N|DIRECT DEBIT)\s*(?:SEPA\s*)?(?:DE\s+)?`,
    String.raw`(?:COMPRA|PAGO)\s+(?:TARJ(?:ETA)?\.?\s*)?(?:EN\s+)?`,
    // Italian
    String.raw`\b(?:ORDINANTE|A FAVORE DI)\s*[:.]?\s*`,
    String.raw`\bBONIFICO\s*(?:SEPA\s*)?(?:ISTANTANEO\s*)?(?:A FAVORE DI|A FAVORE|DISPOSTO A|RICEVUTO DA|DA|A)\s+`,
    String.raw`\b(?:ADDEBITO\s*(?:DIRETTO\s*)?(?:SDD\s*)?|RID\s+)(?:A FAVORE DI\s+|DA\s+)?`,
    // French
    String.raw`\b(?:BENEFICIAIRE|BÉNÉFICIAIRE|EMETTEUR|ÉMETTEUR|DONNEUR D'ORDRE)\s*[:.]?\s*`,
    String.raw`\b(?:VIR(?:EMENT)?\s*(?:SEPA\s*)?(?:INST(?:ANTANE)?\s*)?(?:RECU|REÇU|EMIS|ÉMIS)?\s*(?:DE|A|À|POUR)?|PRLV\s*(?:SEPA\s*)?|PRELEVEMENT\s*(?:SEPA\s*)?)\s+`,
    // German
    String.raw`\b(?:AUFTRAGGEBER|EMPF(?:AE|[AÄ])NGER|ZAHLUNGSEMPF(?:AE|[AÄ])NGER|BEG(?:UE|[UÜ])NSTIGTER)\s*[:.]?\s*`,
    String.raw`\b(?:(?:SEPA-?)?(?:(?:UE|[UÜ])BERWEISUNG|GUTSCHRIFT|LASTSCHRIFT|DAUERAUFTRAG))\s*(?:AN|VON)?\s+`,
    // Portuguese
    String.raw`\b(?:TRF\.?|TRANSF(?:ER[EÊ]NCIA)?\.?)\s*(?:SEPA\s*)?(?:P\/|PARA|DE|A FAVOR DE)\s+`,
    String.raw`\b(?:D[EÉ]BITO DIRETO)\s+(?:DE\s+)?`,
  ].map((p) => new RegExp(p + NAME + NAME_END, 'i'));
  for (const re of patterns) {
    const m = re.exec(t);
    const name = m && m[1] && m[1].trim().replace(/[ ,.-]+$/, '');
    if (name && /[A-Z]/i.test(name) && !GENERIC.has(name.toUpperCase())) return name;
  }
  return null;
}

const STOP = new Set(['SL', 'SLU', 'SA', 'SAU', 'SLL', 'SC', 'CB', 'LTD', 'LIMITED', 'GMBH', 'INC', 'LLC', 'BV', 'SPA', 'SAS', 'SARL', 'DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'AND', 'THE', 'CO', 'COMPANY', 'SOCIEDAD', 'LIMITADA', 'ANONIMA',
  'SRL', 'SRLS', 'SNC', 'SAS', 'SAPA', 'DI', 'DELLA', 'DEI', 'E', 'EURL', 'SASU', 'SCI', 'ET', 'DES', 'DU', 'LE', 'LES', 'AG', 'KG', 'UG', 'OHG', 'GBR', 'EK', 'MBH', 'UND', 'DER', 'DIE', 'DAS', 'CO.KG', 'LDA', 'UNIPESSOAL', 'DA', 'DO', 'DOS', 'DAS']);
const tokens = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^A-Z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

/** 0..1 overlap between two company names, ignoring legal forms (SL, SA, …) and accents. */
export function nameSimilarity(a, b) {
  const x = new Set(tokens(a)), y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}
