// Operator alerts: server errors, failing background work. Sent straight through the mail
// transport to ALERT_EMAIL (not through the database queue, which may be what is failing),
// at most once per 15 minutes for the same kind of problem.
import { config } from './config.js';
import { sendDirect } from './mailer.js';

const last = new Map();
const WINDOW = 15 * 60e3;

export async function alert(kind, detail) {
  console.error(`[alert] ${kind}: ${String(detail).split('\n')[0]}`);
  if (!config.alertEmail) return false;
  const now = Date.now();
  const prev = last.get(kind);
  if (prev && now - prev.at < WINDOW) { prev.suppressed++; return false; }
  const suppressed = prev?.suppressed || 0;
  last.set(kind, { at: now, suppressed: 0 });
  const text = `${kind}\n\n${detail}\n\n${suppressed ? `${suppressed} more of these in the last 15 minutes were not emailed.\n` : ''}Server: ${config.appUrl}\nTime: ${new Date().toISOString()}`;
  try { await sendDirect(config.alertEmail, `[Pescada] ${kind}`, text); return true; } catch (err) { console.error('alert email failed', err.message); return false; }
}
