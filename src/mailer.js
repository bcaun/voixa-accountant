// Outgoing email. Messages are queued in the same transaction as the action
// that causes them, then sent after commit. Each send, failure and (with
// Postmark webhooks) delivery, bounce or spam complaint is written to the
// company's evidence log, so "it went to spam" can be checked, not argued.
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { pool, tx } from './db.js';
import { appendEvent, lockCompany } from './ledger.js';

const SYSTEM = { type: 'system', id: null, name: 'Pescada' };
export const sentMail = []; // filled by the "memory" transport, used in tests

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderEmail({ heading, lines = [], button, footer }) {
  const text = [heading, '', ...lines, '', button ? `${button.label}: ${button.url}` : '', '', footer || 'Pescada'].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#F4F9FA;font-family:'Schibsted Grotesk',Helvetica,Arial,sans-serif;color:#0B2B3F">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F9FA;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #CFE2EC;border-radius:24px">
<tr><td style="padding:26px 32px 0"><span style="font:700 24px/1 'Familjen Grotesk',Helvetica,Arial,sans-serif;letter-spacing:-.03em;color:#0B2B3F">pescada</span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#F5B730;vertical-align:top;margin-left:2px"></span></td></tr>
<tr><td style="padding:20px 32px 10px"><h1 style="margin:0 0 14px;font:700 24px/1.2 'Familjen Grotesk',Helvetica,Arial,sans-serif;letter-spacing:-.02em;color:#0B2B3F">${esc(heading)}</h1>
${lines.map((l) => `<p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:#23445A">${esc(l)}</p>`).join('')}
${button ? `<p style="margin:22px 0 8px"><a href="${esc(button.url)}" style="display:inline-block;background:#1A5DB4;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:999px">${esc(button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 32px 24px;font-size:12.5px;line-height:1.5;color:#3F6478;border-top:1px solid #CFE2EC">${esc(footer || 'Pescada. This message and every action on the document are recorded in the workspace log.')}</td></tr>
</table></td></tr></table></body></html>`;
  return { html, text };
}

/** Queue an email inside the caller's transaction. */
export async function queueEmail(client, m) {
  await client.query(
    `insert into email_messages (company_id, item_id, to_user_id, to_email, kind, subject, html, body_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [m.companyId ?? null, m.itemId ?? null, m.toUserId ?? null, m.toEmail, m.kind, m.subject, m.html, m.text]);
}

let smtp;
async function deliver(m) {
  const t = config.mail.transport;
  if (t === 'memory') { sentMail.push(m); return `mem-${sentMail.length}`; }
  if (t === 'console') {
    console.log(`\n--- email to ${m.to_email}: ${m.subject}\n${m.body_text}\n---`);
    return `console-${m.id}`;
  }
  if (t === 'smtp') {
    smtp ??= nodemailer.createTransport(config.mail.smtpUrl);
    const info = await smtp.sendMail({ from: config.mail.from, to: m.to_email, subject: m.subject, html: m.html, text: m.body_text, headers: { 'X-Voixa-Email-Id': m.id } });
    return info.messageId;
  }
  if (t === 'postmark') {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': config.mail.postmarkToken },
      body: JSON.stringify({
        From: config.mail.from, To: m.to_email, Subject: m.subject, HtmlBody: m.html, TextBody: m.body_text,
        MessageStream: config.mail.postmarkStream, Metadata: { email_id: m.id }, TrackOpens: true,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.ErrorCode) throw new Error(`Postmark ${res.status}: ${out.Message || 'error'}`);
    return out.MessageID;
  }
  throw new Error(`unknown MAIL_TRANSPORT ${t}`);
}

/**
 * Write an email's fate into the log of every item it was about: one item for an ordinary
 * notification, all the listed items for a daily digest. With `once`, only the first time.
 */
async function logEmailEvent(client, m, type, text, data = {}, { once = false } = {}) {
  const targets = m.company_id ? [{ company_id: m.company_id, item_id: m.item_id }]
    : m.kind === 'digest' ? (await client.query('select company_id, item_id from email_items where email_id = $1 order by company_id, item_id', [m.id])).rows : [];
  // lock the companies in a fixed order so two digests cannot deadlock
  for (const id of [...new Set(targets.map((t) => t.company_id))].sort()) await lockCompany(client, id);
  for (const t of targets) {
    if (once) {
      const { rows } = await client.query(`select 1 from events where company_id = $1 and type = $2 and data->>'email_id' = $3
        and item_id is not distinct from $4 limit 1`, [t.company_id, type, m.id, t.item_id]);
      if (rows.length) continue;
    }
    await appendEvent(client, { companyId: t.company_id, itemId: t.item_id, actor: SYSTEM, type,
      text: m.kind === 'digest' ? `${text} (daily summary)` : text, data: { to: m.to_email, kind: m.kind, email_id: m.id, ...data } });
  }
}

let flushing = null;
/** Send everything queued (and retry recent failures). Safe to call often. */
export function flushEmails() {
  flushing ??= (async () => {
    try {
      for (;;) {
        const { rows: [m] } = await pool.query(
          `update email_messages set status = 'sending', attempts = attempts + 1, updated_at = now()
           where id = (select id from email_messages
                       where status = 'queued' or (status = 'failed' and attempts < 5 and updated_at < now() - interval '5 minutes')
                       order by created_at limit 1 for update skip locked)
           returning *`);
        if (!m) break;
        try {
          const providerId = await deliver(m);
          await tx(async (c) => {
            await c.query(`update email_messages set status = 'sent', provider_id = $2, error = null, updated_at = now() where id = $1`, [m.id, providerId]);
            // sign-in links are secrets: once sent, keep only the record that an email went out
            if (m.kind === 'login' || m.kind === 'invite') {
              await c.query(`update email_messages set html = '', body_text = '[sign-in link removed after sending]' where id = $1`, [m.id]);
            }
            await logEmailEvent(c, m, 'email_sent', `Email “${m.subject}” sent to ${m.to_email}`, { provider_id: providerId });
          });
        } catch (err) {
          await tx(async (c) => {
            await c.query(`update email_messages set status = 'failed', error = $2, updated_at = now() where id = $1`, [m.id, String(err.message || err)]);
            if (m.attempts === 1) await logEmailEvent(c, m, 'email_failed', `Email to ${m.to_email} could not be sent: ${err.message}`);
          });
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

const WEBHOOK_STATUS = {
  Delivery: ['delivered', 'email_delivered', (m) => `Email to ${m.to_email} was accepted by the recipient’s mail server`],
  Bounce: ['bounced', 'email_bounced', (m, p) => `Email to ${m.to_email} bounced: ${p.Description || p.Type || 'rejected'}`],
  SpamComplaint: ['spam_complaint', 'email_spam', (m) => `${m.to_email} marked the email as spam`],
  Open: ['opened', 'email_opened', (m) => `${m.to_email} opened the notification email`],
};

/** Postmark webhook payload → status update and log entry. */
export async function handlePostmarkWebhook(p) {
  const rule = WEBHOOK_STATUS[p.RecordType];
  const emailId = p.Metadata?.email_id;
  if (!rule || !emailId) return false;
  const [status, type, text] = rule;
  return tx(async (c) => {
    const { rows: [m] } = await c.query('select * from email_messages where id = $1 for update', [emailId]);
    if (!m) return false;
    if (status !== 'opened') await c.query('update email_messages set status = $2, updated_at = now() where id = $1', [m.id, status]);
    // only the first open of each message is logged
    await logEmailEvent(c, m, type, text(m, p), { email_id: m.id, provider_id: p.MessageID ?? null }, { once: status === 'opened' });
    return true;
  });
}
