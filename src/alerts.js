// Operator alerts: server errors, failing background work. Sent straight through the mail
// transport to ALERT_EMAIL (not through the database queue, which may be what is failing).
// The first alert of a kind goes out at once. If the same kind keeps happening, the gap between
// emails grows (15 minutes, 1 hour, 6 hours, then once a day), so a recurring fault does not
// fill the inbox overnight. After a quiet day the next one goes out at once again.
import { config } from './config.js';
import { sendDirect } from './mailer.js';

const last = new Map();
const GAPS = [15 * 60e3, 60 * 60e3, 6 * 60 * 60e3, 24 * 60 * 60e3];
const QUIET = 24 * 60 * 60e3;
const human = (ms) => (ms >= 864e5 ? `${ms / 864e5} day` : ms >= 36e5 ? `${ms / 36e5} hour${ms > 36e5 ? 's' : ''}` : `${ms / 6e4} minutes`);

export async function alert(kind, detail, now = Date.now()) {
  console.error(`[alert] ${kind}: ${String(detail).split('\n')[0]}`);
  if (!config.alertEmail) return false;
  let st = last.get(kind);
  if (st && now - st.seen > QUIET) st = null; // quiet for a day: start over
  if (st && now - st.at < GAPS[st.level]) { st.suppressed++; st.seen = now; return false; }
  const suppressed = st?.suppressed || 0;
  const level = st ? Math.min(st.level + 1, GAPS.length - 1) : 0;
  last.set(kind, { at: now, seen: now, level, suppressed: 0 });
  const held = suppressed ? `${suppressed} more of these since the last email were not emailed.\n` : '';
  const next = `If this keeps happening, the next email about it comes in ${human(GAPS[level])} at the earliest.\n`;
  const text = `${kind}\n\n${detail}\n\n${held}${next}Server: ${config.appUrl}\nTime: ${new Date(now).toISOString()}`;
  try { await sendDirect(config.alertEmail, `[Pescada] ${kind}`, text); return true; } catch (err) { console.error('alert email failed', err.message); return false; }
}
