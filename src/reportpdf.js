// The tracking report as a PDF (A4), sealed when a seal is configured. Same content as the HTML report.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { collectReport } from './export.js';
import { fmtSize } from './items.js';
import { fmtTime as fmtTimeTz, fmtDay as fmtDayTz, cityOf } from './dates.js';
import { countryOf } from './countries.js';
import { config } from './config.js';
import { sealOn, sealPdf } from './seal.js';

// The standard PDF fonts cover Western European text (WinAnsi); anything else is replaced.
const WIN = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const MAP = { '→': '->', '←': '<-', '✓': 'v', '·': '·', ' ': ' ', ' ': ' ', '−': '-' };
const safe = (s) => [...String(s ?? '')].map((c) => MAP[c] ?? ((c >= ' ' && c <= '~') || (c >= ' ' && c <= 'ÿ') || WIN.has(c) ? c : '?')).join('');

const A4 = [595.28, 841.89], M = 46;
const INK = rgb(0.043, 0.169, 0.247), MUTED = rgb(0.33, 0.38, 0.43), OK = rgb(0.16, 0.44, 0.31), BAD = rgb(0.68, 0.25, 0.17), LINE = rgb(0.8, 0.83, 0.85);

export async function reportPdf(company, { itemId, by }) {
  const r = await collectReport(company, { itemId });
  const tz = r.tz, time = (d) => (d ? fmtTimeTz(d, tz) : '—'), day = (d) => fmtDayTz(d, tz);
  const doc = await PDFDocument.create();
  doc.setTitle(safe(r.title)); doc.setAuthor('Pescada'); doc.setCreator('Pescada'); doc.setProducer('Pescada');
  const font = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold), m: await doc.embedFont(StandardFonts.Courier) };
  let page, y;
  const newPage = () => { page = doc.addPage(A4); y = A4[1] - M; };
  newPage();
  const width = A4[0] - 2 * M;
  const wrap = (text, f, size, w) => {
    const out = [];
    for (const para of safe(text).split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (f.widthOfTextAtSize(next, size) <= w || !line.trim()) {
          // a single word longer than the line (a hash) is cut where it no longer fits
          if (f.widthOfTextAtSize(next, size) > w) { let cut = next; while (f.widthOfTextAtSize(cut, size) > w) cut = cut.slice(0, -1); out.push(cut); line = next.slice(cut.length); } else line = next;
        } else { out.push(line.trimEnd()); line = word.trimStart(); }
      }
      out.push(line.trimEnd());
    }
    return out;
  };
  const text = (s, { f = font.r, size = 9.5, color = INK, x = M, w = width - (x - M), gap = 3 } = {}) => {
    for (const line of wrap(s, f, size, w)) {
      if (y - size < M + 20) newPage();
      page.drawText(line, { x, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  };
  const space = (h) => { y -= h; if (y < M + 40) newPage(); };
  const rule = () => { if (y < M + 30) newPage(); page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.6, color: LINE }); y -= 8; };

  text('PESCADA', { f: font.b, size: 8, color: MUTED });
  space(4);
  text(r.title, { f: font.b, size: 17, gap: 5 });
  text(`${company.name} · Client #${company.no}${company.nif ? ` · ${countryOf(company.country).taxIdLabel} ${company.nif}` : ''} · ${countryOf(company.country).name}`, { color: MUTED });
  text(`Generated ${time(new Date())} by ${by.name || by.email}. Times are ${cityOf(tz)} time.`, { color: MUTED });
  space(6); rule();

  text(r.verification.ok ? 'Log verified.' : 'Log check failed.', { f: font.b, color: r.verification.ok ? OK : BAD });
  text(r.verification.ok
    ? `${r.verification.count} entries; every entry matches its SHA-256 hash and links to the one before it. Latest hash: ${r.verification.headHash || '—'}`
    : r.verification.reason);
  if (r.stamp) {
    space(3);
    text(r.stamp.qualified ? 'Qualified timestamp.' : 'Trusted timestamp.', { f: font.b, color: OK });
    text(`Entries up to #${r.stamp.seq} are sealed by an RFC 3161 timestamp${r.stamp.qualified ? ' from a qualified trust service provider (eIDAS art. 41)' : ''}: ${r.stamp.tsa_name}, ${time(r.stamp.gen_time)}, serial ${r.stamp.serial}.`);
  }
  if (sealOn()) {
    space(3);
    text('Electronic seal.', { f: font.b, color: OK });
    text(`This PDF carries the electronic seal of ${config.seal.name || 'the issuer'}${config.seal.qualified ? ' (qualified electronic seal, eIDAS art. 35)' : ''}. Adobe Acrobat Reader, or the EU DSS validator, shows the seal and whether the document was changed after it was issued.`);
  }
  space(6); rule();

  const kind = { doc: 'Document from client', report: 'Report from accountant', request: 'Request to client' };
  text(itemId ? 'Item' : 'Items', { f: font.b, size: 12, gap: 6 });
  if (!r.items.length) text('No items.', { color: MUTED });
  for (const i of r.items) {
    space(2);
    text(`${i.ref}   ${i.title}`, { f: font.b, size: 10 });
    text(`${kind[i.kind]}${i.due_at ? ` · due ${day(i.due_at)}` : ''}`, { color: MUTED, size: 8.5 });
    for (const v of i.versions) {
      text(`v${v.version}: ${v.file_name} · ${fmtSize(v.size)}${v.replace_reason ? ` · replaced: ${v.replace_reason}` : ''}`, { size: 8.5, x: M + 10 });
      text(`SHA-256 ${v.sha256}`, { f: font.m, size: 7.5, color: MUTED, x: M + 10 });
    }
    const s = i.status;
    text(`Sent ${time(s.sent_at)} · Email ${time(s.notified_at)}${s.email_problem ? ` (${s.email_problem.replace('email_', 'email ')})` : ''} · Opened ${time(s.opened_at)} · ${i.kind === 'report' ? 'Approved' : 'Confirmed'} ${time(s.done_at)}`, { size: 8.5, x: M + 10 });
    space(3);
  }
  space(4); rule();
  text('Activity log', { f: font.b, size: 12, gap: 6 });
  for (const e of r.events) {
    text(`#${e.seq}  ${time(e.at)}  ${e.actor_type}  ${e.text}`, { size: 8.5 });
    text(e.hash, { f: font.m, size: 6.5, color: MUTED, x: M + 14 });
  }
  space(6);
  text("Each entry's hash is SHA-256 over its contents and the previous entry's hash. Changing or removing any entry changes every hash after it. File fingerprints (SHA-256) identify the exact bytes that were sent.", { size: 8, color: MUTED });

  const pages = doc.getPages();
  pages.forEach((p, n) => p.drawText(safe(`${r.title} · page ${n + 1} of ${pages.length}`), { x: M, y: M - 18, size: 7.5, font: font.r, color: MUTED }));
  if (sealOn()) return (await sealPdf(doc, { reason: `Tracking report issued by Pescada for ${safe(company.name)}`, location: 'Pescada (pescada.io)' })).pdf;
  return Buffer.from(await doc.save());
}
