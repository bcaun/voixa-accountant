// Importing clients from a spreadsheet saved as CSV. Columns are found by their names in any of the
// six languages; each row is checked (tax ID, email, duplicates) before anything is created.
import { HttpError } from './auth.js';
import { checkTaxId, isCountry, sameTaxId } from './countries.js';
import * as companies from './companies.js';

export const MAX_ROWS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ALIASES = {
  name: ['name', 'company', 'company name', 'client', 'client name', 'business', 'cliente', 'nombre', 'razon social', 'empresa', 'denominacion', 'denominacion social',
    'ragione sociale', 'denominazione', 'azienda', 'raison sociale', 'societe', 'entreprise', 'nom', 'nom du client', 'firma', 'firmenname', 'unternehmen', 'mandant',
    'mandantenname', 'nome', 'denominacao', 'designacao social', 'nome da empresa'],
  nif: ['nif', 'cif', 'nie', 'nif cif', 'vat', 'vat number', 'vat id', 'tax id', 'taxid', 'tax number', 'partita iva', 'p iva', 'piva', 'codice fiscale', 'cf',
    'siren', 'siret', 'tva', 'numero de tva', 'n tva', 'ust idnr', 'ust id', 'ustid', 'ust idnr steuernummer', 'steuernummer', 'nipc', 'nif nipc', 'contribuinte',
    'identifiant fiscal', 'numero fiscal', 'identificacion fiscal', 'numero de identificacion fiscal', 'identificativo fiscale', 'steuer id', 'steuer identifikationsnummer',
    'numero de identificacao fiscal', 'numero de contribuinte', 'tax identification number'],
  city: ['city', 'town', 'ciudad', 'localidad', 'poblacion', 'municipio', 'citta', 'comune', 'localita', 'ville', 'commune', 'stadt', 'ort', 'cidade', 'localidade', 'concelho'],
  country: ['country', 'pais', 'paese', 'pays', 'land', 'country code'],
  contactName: ['contact', 'contact name', 'contact person', 'contacto', 'nombre contacto', 'nombre del contacto', 'persona de contacto', 'referente', 'contatto',
    'nome contatto', 'interlocuteur', 'nom du contact', 'ansprechpartner', 'kontakt', 'kontaktperson', 'contato', 'nome do contato', 'pessoa de contacto'],
  email: ['email', 'e mail', 'mail', 'email address', 'contact email', 'correo', 'correo electronico', 'email contacto', 'posta elettronica', 'indirizzo email',
    'courriel', 'adresse e mail', 'adresse email', 'e mail adresse', 'emailadresse', 'endereco de email', 'endereco de e mail'],
};
const COUNTRY_NAMES = {
  ES: ['es', 'spain', 'espana', 'spagna', 'espagne', 'spanien', 'espanha'],
  IT: ['it', 'italy', 'italia', 'italie', 'italien', 'italia'],
  FR: ['fr', 'france', 'francia', 'frankreich', 'franca'],
  DE: ['de', 'germany', 'alemania', 'germania', 'allemagne', 'deutschland', 'alemanha'],
  PT: ['pt', 'portugal', 'portogallo'],
};
const countryFrom = (v) => { const n = norm(v); return Object.keys(COUNTRY_NAMES).find((c) => COUNTRY_NAMES[c].includes(n)) || null; };

/** CSV as exported by Excel, LibreOffice, Numbers or Google Sheets: comma, semicolon or tab, quoted fields. */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const delim = [';', ',', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** Which column holds what, from the header row. */
export function mapColumns(header) {
  const cols = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [key, names] of Object.entries(ALIASES)) if (cols[key] === undefined && names.includes(n)) { cols[key] = i; return; }
  });
  // "Name" next to a contact column usually means the contact; the company then has its own column
  if (cols.name === undefined) header.forEach((h, i) => { if (cols.name === undefined && /empresa|company|societ|azienda|firma|razon|ragione|raison/.test(norm(h))) cols.name = i; });
  if (cols.email === undefined) header.forEach((h, i) => { if (cols.email === undefined && /mail|correo|courriel/.test(norm(h))) cols.email = i; });
  return cols;
}

/**
 * Check every row of the file against the firm's clients and each other. Nothing is written.
 * Each result has status 'ok', 'duplicate' or 'error' and, for problems, a message.
 */
export async function planImport(c, user, text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'The file has no clients. Save the spreadsheet as CSV with a header row and one client per row.');
  if (rows.length - 1 > MAX_ROWS) throw new HttpError(400, `The file has more than ${MAX_ROWS} clients. Split it into smaller files.`);
  const cols = mapColumns(rows[0]);
  if (cols.name === undefined) throw new HttpError(400, 'No column with the client’s name was found. Name the column “Name”, “Company”, “Razón social”, “Ragione sociale”, “Raison sociale”, “Firma” or “Nome”.');
  const { rows: [firm] } = await c.query('select country from firms where id = $1', [user.firm_id]);
  const { rows: existing } = await c.query('select name, nif from companies where firm_id = $1 and blocked_at is null', [user.firm_id]);
  const cell = (r, k) => (cols[k] === undefined ? '' : String(r[cols[k]] ?? '').trim());
  const seen = [];
  const out = rows.slice(1).map((r, idx) => {
    const row = { line: idx + 2, name: cell(r, 'name').slice(0, 200), nif: cell(r, 'nif').slice(0, 40), city: cell(r, 'city').slice(0, 100),
      contactName: cell(r, 'contactName').slice(0, 200), email: cell(r, 'email').toLowerCase().slice(0, 200), country: firm.country, status: 'ok' };
    const bad = (message) => Object.assign(row, { status: 'error', message });
    const raw = cell(r, 'country');
    if (raw) { const cc = countryFrom(raw); if (!cc || !isCountry(cc)) return bad(`Unknown country “${raw}”. Use ES, IT, FR, DE or PT.`); row.country = cc; }
    if (!row.name) return bad('The client’s name is missing.');
    if (row.nif) {
      const t = checkTaxId(row.country, row.nif);
      if (!t.ok) return bad(t.message);
      row.nif = t.value;
    }
    if (row.email && !EMAIL_RE.test(row.email)) return bad(`“${row.email}” is not a valid email address.`);
    const dupOf = (x) => (row.nif && x.nif ? sameTaxId(row.nif, x.nif) : !row.nif && norm(x.name) === norm(row.name));
    if (existing.some(dupOf)) return Object.assign(row, { status: 'duplicate', message: 'Already one of your clients.' });
    const earlier = seen.find(dupOf);
    if (earlier) return Object.assign(row, { status: 'duplicate', message: `Same client as line ${earlier.line}.` });
    seen.push(row);
    return row;
  });
  return { columns: Object.keys(cols), rows: out };
}

/** Create the clients that passed the check, one transaction each, so one failure does not stop the rest. */
export async function runImport(tx, user, plan, { invite }) {
  for (const row of plan.rows.filter((r) => r.status === 'ok')) {
    try {
      row.id = await tx(async (c) => {
        const co = await companies.createCompany(c, { user, name: row.name, nif: row.nif, city: row.city, country: row.country });
        if (invite && row.email) await companies.addMember(c, { user, company: co, email: row.email, name: row.contactName });
        return co.id;
      });
      row.status = 'created';
    } catch (err) {
      Object.assign(row, { status: 'error', message: err.message });
    }
  }
  return plan;
}
