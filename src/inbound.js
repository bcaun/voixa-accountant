// Documents by email. Postmark receives mail for INBOUND_DOMAIN and posts it here as JSON.
// The address <key>@INBOUND_DOMAIN belongs to one client workspace; the key is random, so it
// cannot be guessed. A message is accepted only from a current member of that workspace and,
// unless switched off, only when the sender's domain passes SPF or DKIM, so a forged From is
// refused. Each attachment then goes through the same path as an upload: stored, fingerprinted,
// virus-scanned, logged, notified and read.
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { companyHasPro } from './billing.js';
import { tx } from './db.js';
import { storage } from './storage.js';
import { scanStored } from './antivirus.js';
import { COMPANY_SQL } from './auth.js';
import { appendEvent, lockCompany } from './ledger.js';
import { createDocument, SYSTEM } from './items.js';
import { queueEmail, renderEmail, flushEmails, clientPromo } from './mailer.js';
import { processJobs } from './recognition/recognize.js';
import { translator, langFor } from './i18n.js';

const CATEGORY = [
  [/\b(factura|fattura|facture|rechnung|fatura|invoice|ricevuta|recibo)/i, 'Invoice'],
  [/\b(extracto|estratto|relev[eé]|kontoauszug|extrato|statement|movimientos)/i, 'Bank statement'],
  [/\b(contrato|contratto|contrat|vertrag|contract)/i, 'Contract'],
];
const guessCategory = (subject, name) => {
  if (/\.(xml|p7m)$/i.test(name)) return 'Invoice';
  for (const [re, cat] of CATEGORY) if (re.test(subject) || re.test(name)) return cat;
  return 'Other';
};

/** Did the sending domain authenticate? Postmark passes the receiving server's verdicts as headers. */
export function senderAuthenticated(headers = []) {
  const h = (n) => headers.filter((x) => String(x.Name).toLowerCase() === n).map((x) => String(x.Value).toLowerCase());
  return h('received-spf').some((v) => v.startsWith('pass')) || h('authentication-results').some((v) => /\b(dkim|spf)=pass\b/.test(v));
}

const keyOf = (p) => {
  const rcpts = [p.OriginalRecipient, ...(p.ToFull || []).map((t) => t.Email), ...(p.CcFull || []).map((t) => t.Email)].filter(Boolean).map((e) => String(e).toLowerCase());
  const mine = rcpts.find((e) => e.endsWith(`@${config.mail.inboundDomain}`));
  return mine ? mine.split('@')[0].replace(/\+.*$/, '') : null;
};

export async function handleInbound(p) {
  if (!config.mail.inboundDomain) return { status: 'off' };
  const key = keyOf(p);
  if (!key) return { status: 'no_address' };
  const from = String(p.FromFull?.Email || p.From || '').toLowerCase().trim();
  const subject = String(p.Subject || '').slice(0, 300);
  const atts = (p.Attachments || []).filter((a) => a.Content && !(a.ContentID && /^image\//.test(a.ContentType) && (a.ContentLength || 0) < 20000));

  const files = [];
  const result = await tx(async (c) => {
    const { rows: [company] } = await c.query(`${COMPANY_SQL} where c.inbound_key = $1`, [key]);
    if (!company) return { status: 'unknown_address' };
    await lockCompany(c, company.id);
    const { rows: [member] } = await c.query(
      `select u.* from memberships m join users u on u.id = m.user_id
       where m.company_id = $1 and m.removed_at is null and u.disabled_at is null and u.email = $2`, [company.id, from]);
    const refuse = async (why) => {
      await appendEvent(c, { companyId: company.id, actor: SYSTEM, type: 'email_in_refused',
        text: `An email to the workspace address from ${from || 'an unknown sender'} (“${subject}”) was refused: ${why}`, data: { from, subject, reason: why } });
      return { status: 'refused', reason: why };
    };
    if (!companyHasPro(company)) return refuse('the workspace email address is part of the Pro plan, and the firm is not on Pro');
    if (!member) return refuse('the sender is not one of the people with access to this workspace');
    if (config.mail.inboundRequireAuth && !senderAuthenticated(p.Headers)) return refuse('the sender’s domain did not pass SPF or DKIM, so the sender cannot be confirmed');
    if (!atts.length) return refuse('it had no attachments');

    for (const a of atts.slice(0, 20)) {
      const buf = Buffer.from(a.Content, 'base64');
      if (buf.length > config.maxUploadMb * 1048576) return refuse(`“${a.Name}” is larger than ${config.maxUploadMb} MB`);
      const f = { key: `companies/${company.id}/${randomUUID()}`, name: String(a.Name || 'attachment').slice(0, 255), mime: a.ContentType || 'application/octet-stream',
        size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
      await storage.put(f.key, Readable.from(buf), f.mime);
      files.push(f);
      f.scan = await scanStored(f.key);
      if (f.scan.status === 'infected') return refuse(`“${f.name}” contains malware (${f.scan.signature})`);
    }
    const note = `Sent by email from ${from}${subject ? `: “${subject}”` : ''}`;
    for (const f of files) {
      await createDocument(c, { user: member, company, file: f, category: guessCategory(subject, f.name), period: '', note, requestId: null });
    }
    const lang = langFor(member, company.country);
    const t = translator(lang);
    const { html, text } = renderEmail({ promo: clientPromo(lang), heading: files.length === 1 ? t('Received: 1 document') : t('Received: {n} documents', { n: files.length }),
      lines: [t('{firm} has received what you sent to the {company} workspace:', { firm: company.firm_name, company: company.name }), ...files.map((f) => `• ${f.name} (SHA-256 ${f.sha256.slice(0, 16)}…)`),
        t('Each file is now in the workspace, and every step is recorded in its log.')],
      button: { label: t('Open the workspace'), url: `${config.appUrl}/#/c/${company.id}` } });
    await queueEmail(c, { companyId: company.id, toUserId: member.id, toEmail: member.email, kind: 'email_in_receipt', subject: t('Received: {subject}', { subject: subject || String(files.length) }), html, text });
    return { status: 'accepted', count: files.length, companyId: company.id };
  }).catch(async (err) => {
    await Promise.all(files.map((f) => storage.remove(f.key).catch(() => {})));
    throw err;
  });
  if (result.status === 'refused') await Promise.all(files.map((f) => storage.remove(f.key).catch(() => {})));
  if (result.status === 'accepted') { flushEmails().catch(() => {}); processJobs().catch(() => {}); }
  return result;
}

export const inboundAddress = (company) => (config.mail.inboundDomain ? `${company.inbound_key}@${config.mail.inboundDomain}` : null);
