// What changes from one country to another: the time zone deadlines are counted in,
// the client's tax ID, the recurring deadline templates and hints for reading documents.
// Deadline templates are starting points the accountant can edit; dates that move with
// weekends or the company's situation say so in their note.

const monthlyDocs = (title, category, day = 5) => ({ kind: 'request', title, category, frequency: 'monthly', dueDay: day, leadDays: 7 });

export const COUNTRIES = {
  ES: {
    code: 'ES', name: 'Spain', tz: 'Europe/Madrid', taxIdLabel: 'NIF', taxIdHint: 'B12345678',
    language: 'Spanish', taxIdNames: 'NIF, CIF or NIE (e.g. B12345678), or a Spanish VAT number ESB12345678',
    bankFormats: 'Norma 43 (AEB 43), camt.053, CSV, PDF',
    presets: [
      { ...monthlyDocs('Bank statements', 'Bank statement'), label: 'Bank statements, monthly by the 5th' },
      { ...monthlyDocs('Sales and purchase invoices', 'Invoice'), label: 'Sales and purchase invoices, monthly by the 5th' },
      { label: 'VAT return (Modelo 303), quarterly by the 20th', kind: 'report', title: 'VAT return (Modelo 303)', category: 'Tax return', frequency: 'quarterly', dueDay: 20, leadDays: 10, note: 'The fourth quarter is due on 30 January.' },
      { label: 'Withholding tax (Modelo 111), quarterly by the 20th', kind: 'report', title: 'Withholding tax (Modelo 111)', category: 'Tax return', frequency: 'quarterly', dueDay: 20, leadDays: 10 },
      { label: 'Rent withholding (Modelo 115), quarterly by the 20th', kind: 'report', title: 'Rent withholding (Modelo 115)', category: 'Tax return', frequency: 'quarterly', dueDay: 20, leadDays: 10 },
      { label: 'Annual VAT summary (Modelo 390), 30 January', kind: 'report', title: 'Annual VAT summary (Modelo 390)', category: 'Tax return', frequency: 'yearly', dueDay: 30, dueMonth: 1, leadDays: 14 },
    ],
  },
  IT: {
    code: 'IT', name: 'Italy', tz: 'Europe/Rome', taxIdLabel: 'Partita IVA / Codice fiscale', taxIdHint: '01234567897',
    language: 'Italian', taxIdNames: 'Partita IVA (11 digits, VAT number IT + 11 digits) or Codice Fiscale (16 characters for people, 11 digits for companies)',
    bankFormats: 'camt.053, CSV, PDF; e-invoices as FatturaPA XML (also signed .p7m)',
    presets: [
      { ...monthlyDocs('Bank statements (estratti conto)', 'Bank statement'), label: 'Bank statements, monthly by the 5th' },
      { ...monthlyDocs('Purchase invoices and receipts', 'Invoice'), label: 'Purchase invoices and receipts, monthly by the 5th' },
      { label: 'F24: monthly VAT and withholdings, by the 16th', kind: 'report', title: 'F24 (IVA mensile e ritenute)', category: 'Tax return', frequency: 'monthly', dueDay: 16, leadDays: 7, note: 'Moves to the next working day when the 16th is a weekend or holiday.' },
      { label: 'Certificazione Unica (CU), 16 March', kind: 'report', title: 'Certificazione Unica (CU)', category: 'Tax return', frequency: 'yearly', dueDay: 16, dueMonth: 3, leadDays: 21 },
      { label: 'Annual VAT return (Dichiarazione IVA), 30 April', kind: 'report', title: 'Dichiarazione IVA', category: 'Tax return', frequency: 'yearly', dueDay: 30, dueMonth: 4, leadDays: 21 },
      { label: 'Modello 770, 31 October', kind: 'report', title: 'Modello 770', category: 'Tax return', frequency: 'yearly', dueDay: 31, dueMonth: 10, leadDays: 21 },
      { label: 'Income tax return (Redditi), 31 October', kind: 'report', title: 'Dichiarazione dei redditi (Redditi)', category: 'Tax return', frequency: 'yearly', dueDay: 31, dueMonth: 10, leadDays: 21 },
    ],
  },
  FR: {
    code: 'FR', name: 'France', tz: 'Europe/Paris', taxIdLabel: 'SIREN / TVA', taxIdHint: '732829320',
    language: 'French', taxIdNames: 'SIREN (9 digits), SIRET (14 digits) or VAT number FR + 2 characters + SIREN',
    bankFormats: 'CFONB 120, camt.053, CSV, PDF; e-invoices as Factur-X PDF, UBL or CII XML',
    presets: [
      { ...monthlyDocs('Bank statements (relevés bancaires)', 'Bank statement'), label: 'Bank statements, monthly by the 5th' },
      { ...monthlyDocs('Purchase and sales invoices', 'Invoice'), label: 'Purchase and sales invoices, monthly by the 5th' },
      { label: 'VAT return (CA3), monthly', kind: 'report', title: 'Déclaration de TVA (CA3)', category: 'Tax return', frequency: 'monthly', dueDay: 19, leadDays: 7, note: 'The day is set per company between the 15th and the 24th: check it in the company’s impots.gouv.fr calendar.' },
      { label: 'Payroll declaration (DSN), monthly by the 15th', kind: 'report', title: 'Déclaration sociale nominative (DSN)', category: 'Payroll', frequency: 'monthly', dueDay: 15, leadDays: 5, note: 'The 5th for employers with 50 or more employees.' },
      { label: 'Annual VAT return (CA12), early May', kind: 'report', title: 'Déclaration annuelle de TVA (CA12)', category: 'Tax return', frequency: 'yearly', dueDay: 5, dueMonth: 5, leadDays: 21, note: 'Due on the second working day after 1 May; check the exact date each year.' },
    ],
  },
  DE: {
    code: 'DE', name: 'Germany', tz: 'Europe/Berlin', taxIdLabel: 'USt-IdNr. / Steuernummer', taxIdHint: 'DE136695976',
    language: 'German', taxIdNames: 'USt-IdNr. (DE + 9 digits) or Steuernummer (10 to 13 digits, often written with slashes)',
    bankFormats: 'MT940, camt.053, CSV, PDF; e-invoices as XRechnung (UBL or CII) or ZUGFeRD PDF',
    presets: [
      { ...monthlyDocs('Bank statements (Kontoauszüge)', 'Bank statement'), label: 'Bank statements, monthly by the 5th' },
      { ...monthlyDocs('Receipts and invoices (Belege)', 'Invoice'), label: 'Receipts and invoices, monthly by the 5th' },
      { label: 'VAT pre-return (UStVA), monthly by the 10th', kind: 'report', title: 'Umsatzsteuer-Voranmeldung (UStVA)', category: 'Tax return', frequency: 'monthly', dueDay: 10, leadDays: 5, note: 'One month later with Dauerfristverlängerung.' },
      { label: 'VAT pre-return (UStVA), quarterly by the 10th', kind: 'report', title: 'Umsatzsteuer-Voranmeldung (UStVA)', category: 'Tax return', frequency: 'quarterly', dueDay: 10, leadDays: 7, note: 'One month later with Dauerfristverlängerung.' },
      { label: 'Wage tax return (Lohnsteuer-Anmeldung), monthly by the 10th', kind: 'report', title: 'Lohnsteuer-Anmeldung', category: 'Payroll', frequency: 'monthly', dueDay: 10, leadDays: 5 },
      { label: 'EC sales list (Zusammenfassende Meldung), monthly by the 25th', kind: 'report', title: 'Zusammenfassende Meldung', category: 'Tax return', frequency: 'monthly', dueDay: 25, leadDays: 5 },
      { label: 'Annual returns without an adviser, 31 July', kind: 'report', title: 'Jahressteuererklärungen', category: 'Tax return', frequency: 'yearly', dueDay: 31, dueMonth: 7, leadDays: 30, note: 'With a Steuerberater the deadline is the end of February of the second year after; set it by hand.' },
    ],
  },
  PT: {
    code: 'PT', name: 'Portugal', tz: 'Europe/Lisbon', taxIdLabel: 'NIF / NIPC', taxIdHint: '501964843',
    language: 'Portuguese', taxIdNames: 'NIF or NIPC (9 digits), or VAT number PT + 9 digits',
    bankFormats: 'camt.053, CSV, PDF',
    presets: [
      { ...monthlyDocs('Bank statements (extratos bancários)', 'Bank statement'), label: 'Bank statements, monthly by the 5th' },
      { ...monthlyDocs('Purchase and sales invoices (faturas)', 'Invoice'), label: 'Purchase and sales invoices, monthly by the 5th' },
      { label: 'Periodic VAT return, monthly regime: 20th of the second month', kind: 'report', title: 'Declaração periódica de IVA', category: 'Tax return', frequency: 'monthly', dueDay: 20, monthOffset: 2, leadDays: 10 },
      { label: 'Periodic VAT return, quarterly regime: 20th of the second month', kind: 'report', title: 'Declaração periódica de IVA', category: 'Tax return', frequency: 'quarterly', dueDay: 20, monthOffset: 2, leadDays: 10 },
      { label: 'Monthly pay return (DMR), by the 10th', kind: 'report', title: 'Declaração Mensal de Remunerações (DMR)', category: 'Payroll', frequency: 'monthly', dueDay: 10, leadDays: 5 },
      { label: 'Corporate income tax (Modelo 22), 31 May', kind: 'report', title: 'Modelo 22 (IRC)', category: 'Tax return', frequency: 'yearly', dueDay: 31, dueMonth: 5, leadDays: 21 },
      { label: 'Annual information return (IES), 15 July', kind: 'report', title: 'IES / Declaração Anual', category: 'Tax return', frequency: 'yearly', dueDay: 15, dueMonth: 7, leadDays: 21 },
    ],
  },
};

export const COUNTRY_CODES = Object.keys(COUNTRIES);
export const LANGS = ['en', 'es', 'it', 'fr', 'de', 'pt'];
/** The language people in a country are written to by default. */
export const langOfCountry = (code) => ({ ES: 'es', IT: 'it', FR: 'fr', DE: 'de', PT: 'pt' }[code] || 'en');
export const isCountry = (c) => COUNTRY_CODES.includes(c);
export const countryOf = (code) => COUNTRIES[code] || COUNTRIES.ES;
export const tzOf = (code) => countryOf(code).tz;

/** What the web client needs to know about each country. */
export const publicCountries = () => COUNTRY_CODES.map((k) => {
  const c = COUNTRIES[k];
  return { code: k, name: c.name, tz: c.tz, taxIdLabel: c.taxIdLabel, taxIdHint: c.taxIdHint, bankFormats: c.bankFormats, presets: c.presets };
});

/* ---------- tax IDs ---------- */

const digits = (s) => [...s].map(Number);
const luhn = (s) => {
  let sum = 0;
  digits(s).reverse().forEach((d, i) => { if (i % 2) { d *= 2; if (d > 9) d -= 9; } sum += d; });
  return sum % 10 === 0;
};

/** Italian Partita IVA: 11 digits, last one a check digit. */
export const validPartitaIva = (s) => /^\d{11}$/.test(s) && luhn(s);
/** Italian Codice Fiscale for people (16 characters; digits can be replaced by letters in homonym cases). */
export function validCodiceFiscale(s) {
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(s)) return false;
  const ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = s[i];
    const v = /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65;
    sum += i % 2 === 0 ? ODD[v] : v;
  }
  return String.fromCharCode(65 + (sum % 26)) === s[15];
}
/** French SIREN (9 digits) and SIRET (14 digits) use the Luhn check. */
export const validSiren = (s) => /^\d{9}$/.test(s) && luhn(s);
export const validSiret = (s) => /^\d{14}$/.test(s) && (luhn(s) || s.startsWith('356000000'));
/** French VAT number: FR + 2-digit key + SIREN, key = (12 + 3 × (SIREN mod 97)) mod 97. Letter keys are accepted unchecked. */
export function validFrenchVat(s) {
  const m = /^FR([0-9A-HJ-NP-Z]{2})(\d{9})$/.exec(s);
  if (!m) return false;
  if (!/^\d\d$/.test(m[1])) return true;
  return Number(m[1]) === (12 + 3 * (Number(m[2]) % 97)) % 97;
}
/** German USt-IdNr: DE + 9 digits, ISO 7064 MOD 11,10 check digit. */
export function validGermanVat(s) {
  const m = /^DE(\d{9})$/.exec(s);
  if (!m) return false;
  let p = 10;
  for (const d of digits(m[1].slice(0, 8))) {
    let x = (d + p) % 10;
    if (x === 0) x = 10;
    p = (2 * x) % 11;
  }
  let check = 11 - p;
  if (check === 10) check = 0;
  return check === Number(m[1][8]);
}
/** German Steuernummer: 10 or 11 digits as printed (e.g. 12/345/67890), or the 13-digit ELSTER form. No public check digit. */
export const validSteuernummer = (raw) => {
  const d = raw.replace(/[\s/]/g, '');
  return /^\d{10,13}$/.test(d);
};
/** Portuguese NIF/NIPC: 9 digits, mod-11 check digit. */
export function validPortugueseNif(s) {
  if (!/^[1-35689]\d{8}$/.test(s) && !/^(45|7[0-9]|9[0-9])\d{7}$/.test(s)) return false;
  const d = digits(s);
  const sum = d.slice(0, 8).reduce((a, x, i) => a + x * (9 - i), 0);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  return check === d[8];
}
/** Spanish NIF, CIF or NIE (format only). */
export const validSpanishNif = (s) => /^([ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/.test(s);

const compact = (s) => String(s || '').toUpperCase().replace(/[\s.\-]/g, '');

/**
 * Check a tax ID typed for a client in a country. Returns { ok, value, message }:
 * value is the cleaned form to store; message explains what is expected when it is not valid.
 */
export function checkTaxId(country, raw) {
  const v = compact(raw);
  if (!v) return { ok: true, value: '' };
  const c = countryOf(country);
  const bad = { ok: false, value: v, message: `That does not look like a valid ${c.taxIdLabel} for ${c.name}. Expected: ${c.taxIdNames}.` };
  switch (c.code) {
    case 'ES': {
      const x = v.replace(/^ES/, '');
      return validSpanishNif(x) ? { ok: true, value: x } : bad;
    }
    case 'IT': {
      const x = v.replace(/^IT/, '');
      return validPartitaIva(x) || validCodiceFiscale(x) ? { ok: true, value: x } : bad;
    }
    case 'FR': {
      if (validSiren(v) || validSiret(v) || validFrenchVat(v)) return { ok: true, value: v };
      return bad;
    }
    case 'DE': {
      if (validGermanVat(v)) return { ok: true, value: v };
      const st = String(raw || '').trim();
      return validSteuernummer(st) ? { ok: true, value: st.replace(/\s/g, '') } : bad;
    }
    case 'PT': {
      const x = v.replace(/^PT/, '');
      return validPortugueseNif(x) ? { ok: true, value: x } : bad;
    }
    default: return { ok: true, value: v };
  }
}

/**
 * The comparable core of a tax ID: letters and digits only, without an EU country prefix,
 * French VAT numbers and SIRETs reduced to the SIREN, Steuernummer slashes removed.
 */
export function taxCore(raw) {
  let v = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!v) return '';
  const fr = /^FR[0-9A-Z]{2}(\d{9})$/.exec(v);
  if (fr) return fr[1];
  if (/^\d{14}$/.test(v) && validSiret(v)) return v.slice(0, 9);
  v = v.replace(/^(ES|IT|DE|PT|AT|BE|NL|LU|IE|EL|CY|MT|SI|SK|CZ|PL|HU|RO|BG|HR|DK|SE|FI|EE|LV|LT)(?=[0-9A-Z]{8,})/, '');
  return v;
}

/** Do two tax IDs identify the same business? */
export function sameTaxId(a, b) {
  const x = taxCore(a), y = taxCore(b);
  return !!x && !!y && x === y;
}
