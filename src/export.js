// Exports for disputes: the raw log as CSV, and a printable tracking report
// (open it in a browser and print or save as PDF).
import { config } from './config.js';
import { query } from './db.js';
import { verifyCompany } from './ledger.js';
import { computeStatus, fmtSize, refOf } from './items.js';
import { fmtDay, fmtTime } from './dates.js';

const csvCell = (v) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from treating text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportCsv(company) {
  const { rows } = await query(
    `select e.*, i.seq as item_seq, i.title as item_title from events e left join items i on i.id = e.item_id
     where e.company_id = $1 order by e.seq`, [company.id]);
  const head = ['seq', 'time_utc', 'time_madrid', 'actor_type', 'actor_name', 'event', 'ref', 'item', 'description', 'data', 'prev_hash', 'hash'];
  const lines = [head.join(',')];
  for (const e of rows) {
    lines.push([e.seq, e.at, fmtTime(e.at), e.actor_type, e.actor_name, e.type,
      e.item_seq ? refOf(company, { seq: e.item_seq }) : '', e.item_title || '', e.text, JSON.stringify(e.data), e.prev_hash, e.hash].map(csvCell).join(','));
  }
  const day = new Date().toISOString().slice(0, 10);
  return { filename: `voixa-${String(company.no).padStart(3, '0')}-log-${day}.csv`, body: '﻿' + lines.join('\r\n') + '\r\n' };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function exportReport(company, { itemId, by }) {
  const verification = await verifyCompany({ query }, company.id);
  const { rows: its } = await query(`select * from items where company_id = $1 ${itemId ? 'and id = $2' : ''} order by seq`, itemId ? [company.id, itemId] : [company.id]);
  const ids = its.map((i) => i.id);
  const { rows: evs } = await query(
    `select * from events where company_id = $1 ${itemId ? 'and item_id = $2' : ''} order by seq`, itemId ? [company.id, itemId] : [company.id]);
  const { rows: vers } = await query('select * from versions where item_id = any($1) order by version', [ids]);
  const evByItem = {};
  for (const e of evs) if (e.item_id) (evByItem[e.item_id] ||= []).push(e);
  const kindLabel = { doc: 'Document from client', report: 'Report from accountant', request: 'Request to client' };
  const step = (t) => (t ? fmtTime(t) : '—');
  const itemRows = its.map((i) => {
    const s = computeStatus(i.kind, evByItem[i.id] || []);
    const vs = vers.filter((v) => v.item_id === i.id);
    return `<tr><td class="m nw">${refOf(company, i)}</td><td><b>${esc(i.title)}</b><br><span class="mu">${kindLabel[i.kind]}${i.due_at ? ` · due ${fmtDay(i.due_at)}` : ''}</span>
      ${vs.map((v) => `<div class="mu m">v${v.version}: ${esc(v.file_name)} · ${fmtSize(v.size)} · SHA-256 ${v.sha256}${v.replace_reason ? ` · replaced: ${esc(v.replace_reason)}` : ''}</div>`).join('')}</td>
      <td>${step(s.sent_at)}</td><td>${step(s.notified_at)}${s.email_problem ? `<br><span class="bad">${s.email_problem.replace('email_', 'email ')}</span>` : ''}</td><td>${step(s.opened_at)}</td><td>${step(s.done_at)}</td></tr>`;
  }).join('');
  const evRows = evs.map((e) => `<tr><td class="m">${e.seq}</td><td class="m nw">${fmtTime(e.at)}</td><td>${e.actor_type}</td><td>${esc(e.text)}</td><td class="m h">${e.hash}</td></tr>`).join('');
  const title = itemId && its[0] ? `Tracking report ${refOf(company, its[0])}` : `Tracking report: ${company.name}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font:12px/1.5 Inter,Helvetica,Arial,sans-serif;color:#1C2A38;margin:32px;max-width:1100px}
h1{font:500 22px/1.2 Georgia,serif;color:#0F2438;margin:0 0 4px} h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#55616D;margin:28px 0 8px}
table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid #E1E7EC;padding:6px 8px;text-align:left;vertical-align:top} th{font-size:11px;color:#55616D}
.m{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px} .mu{color:#55616D} .nw{white-space:nowrap} .h{word-break:break-all;color:#55616D}
.box{border:1px solid #CBD3D9;border-radius:8px;padding:10px 14px;margin-top:14px} .ok{color:#2A7150;font-weight:600} .bad{color:#AE402B;font-weight:600}
@media print{body{margin:12mm} a{color:inherit}}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="mu">${esc(company.name)} · Client #${company.no}${company.nif ? ` · NIF ${esc(company.nif)}` : ''} · ${esc(config.firmName)}</div>
<div class="mu">Generated ${fmtTime(new Date())} by ${esc(by.name || by.email)}. Times are Madrid time.</div>
<div class="box">${verification.ok
    ? `<span class="ok">Log verified.</span> ${verification.count} entries; every entry matches its SHA-256 hash and links to the one before it. Latest hash: <span class="m">${verification.headHash || '—'}</span>`
    : `<span class="bad">Log check failed:</span> ${esc(verification.reason)}.`}</div>
<h2>${itemId ? 'Item' : 'Items'}</h2>
<table><thead><tr><th>Ref</th><th>Title and files</th><th>Sent</th><th>Email notification</th><th>Opened by recipient</th><th>Confirmed / approved</th></tr></thead><tbody>${itemRows || '<tr><td colspan="6">No items.</td></tr>'}</tbody></table>
<h2>Activity log</h2>
<table><thead><tr><th>#</th><th>Time</th><th>Who</th><th>What happened</th><th>Entry hash</th></tr></thead><tbody>${evRows}</tbody></table>
<p class="mu" style="margin-top:20px">Each entry's hash is SHA-256 over its contents and the previous entry's hash. Changing or removing any entry changes every hash after it. File fingerprints (SHA-256) identify the exact bytes that were sent.</p>
</body></html>`;
}
