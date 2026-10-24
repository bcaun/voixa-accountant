// Outgoing email. Messages are queued in the same transaction as the action
// that causes them, then sent after commit. Each send, failure and (with
// Postmark webhooks) delivery, bounce or spam complaint is written to the
// company's evidence log, so "it went to spam" can be checked, not argued.
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { pool, tx } from './db.js';
import { appendEvent } from './ledger.js';

const SYSTEM = { type: 'system', id: null, name: 'Voixa Exchange' };
export const sentMail = []; // filled by the "memory" transport, used in tests

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderEmail({ heading, lines = [], button, footer }) {
  const text = [heading, '', ...lines, '', button ? `${button.label}: ${button.url}` : '', '', footer || `${config.firmName} · Voixa Exchange`].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#F1F5F9;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#3F4A56">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E1E7EC;border-radius:14px">
<tr><td style="padding:22px 28px 0"><span style="font:600 13px/1 Helvetica,Arial,sans-serif;letter-spacing:.12em;color:#0F2438">VOIXA</span>
<span style="font:500 11px/1 Helvetica,Arial,sans-serif;letter-spacing:.08em;color:#66727F;padding-left:8px">EXCHANGE</span>
<div style="height:3px;width:56px;background:#E0C19C;border-radius:2px;margin-top:10px"></div></td></tr>
<tr><td style="padding:18px 28px 8px"><h1 style="margin:0 0 12px;font:500 22px/1.25 Georgia,serif;color:#0F2438">${esc(heading)}</h1>
${lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.55">${esc(l)}</p>`).join('')}
${button ? `<p style="margin:18px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#0F2438;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:14px;padding:11px 22px;border-radius:999px">${esc(button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:14px 28px 22px;font-size:12px;color:#66727F;border-top:1px solid #E1E7EC">${esc(footer || `${config.firmName} · Voixa Exchange. This message and every action on the document are recorded in the workspace log.`)}</td></tr>
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

async function logEmailEvent(client, m, type, text, data = {}) {
  if (!m.company_id) return;
  await appendEvent(client, { companyId: m.company_id, itemId: m.item_id, actor: SYSTEM, type, text, data: { to: m.to_email, kind: m.kind, email_id: m.id, ...data } });
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
    if (status === 'opened') {
      // log only the first open of each message
      const { rows } = await c.query(`select 1 from events where company_id = $1 and type = 'email_opened' and data->>'email_id' = $2 limit 1`, [m.company_id, m.id]);
      if (rows.length) return true;
    } else {
      await c.query('update email_messages set status = $2, updated_at = now() where id = $1', [m.id, status]);
    }
    await logEmailEvent(c, m, type, text(m, p), { email_id: m.id, provider_id: p.MessageID ?? null });
    return true;
  });
}
