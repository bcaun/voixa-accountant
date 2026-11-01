// Deadlines are the end of the day in the client's country (Madrid, Rome, Paris, Berlin
// or Lisbon), the jurisdiction the filings belong to. Every helper takes the time zone;
// it defaults to Madrid, where the product started.
export const DEFAULT_TZ = 'Europe/Madrid';

function offsetMs(utcMs, tz) {
  const d = new Date(utcMs);
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return local - utc;
}

/** 23:59:59 local time on the given calendar day (month is 0-based; days past the month's end clamp to its last day). */
export function endOfDay(y, m, d, tz = DEFAULT_TZ) {
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const guess = Date.UTC(yy, mm, Math.min(d, last), 23, 59, 59);
  return new Date(guess - offsetMs(guess, tz));
}
export const madridEndOfDay = (y, m, d) => endOfDay(y, m, d, 'Europe/Madrid');

/** "2026-11-05" → end of that day in the time zone. Returns null for anything else. */
export function parseDay(s, tz = DEFAULT_TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return endOfDay(+m[1], +m[2] - 1, +m[3], tz);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The next due date of a recurring obligation on or after `from`, and the period it covers.
 * monthly:   day N of the month `month_offset` months after each month (1 = the following month)
 * quarterly: day N of the month `month_offset` months after each quarter ends (1 = Jan, Apr, Jul, Oct)
 * yearly:    day N of month M, for the previous calendar year
 */
export function dueAfter(ob, from, tz = DEFAULT_TZ) {
  const f = new Date(from);
  const offset = ob.month_offset || 1;
  // walk the periods, starting a little before `from` so a due date in the current month is not skipped
  let y = f.getUTCFullYear();
  let m = f.getUTCMonth() - 15;
  for (let i = 0; i < 60; i++, m++) {
    const py = y + Math.floor(m / 12), pm = ((m % 12) + 12) % 12; // period month (0-based)
    let period = null, dueY, dueM;
    if (ob.frequency === 'monthly') {
      period = { period: `${py}-${String(pm + 1).padStart(2, '0')}`, periodLabel: `${MONTHS[pm]} ${py}` };
      dueY = py; dueM = pm + offset;
    } else if (ob.frequency === 'quarterly' && pm % 3 === 2) {
      const q = (pm + 1) / 3;
      period = { period: `${py}-Q${q}`, periodLabel: `Q${q} ${py}` };
      dueY = py; dueM = pm + offset;
    } else if (ob.frequency === 'yearly' && pm === 11) {
      period = { period: String(py), periodLabel: String(py) };
      dueY = py + 1; dueM = (ob.due_month ?? 1) - 1;
    }
    if (!period) continue;
    const due = endOfDay(dueY, dueM, ob.due_day, tz);
    if (due >= f) return { due, ...period };
  }
  return null;
}

export const fmtDay = (d, tz = DEFAULT_TZ) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
export const fmtTime = (d, tz = DEFAULT_TZ) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz, timeZoneName: 'short' });
/** "Madrid", "Rome", … for labels such as "Times are Rome time". */
export const cityOf = (tz = DEFAULT_TZ) => tz.split('/').pop().replace(/_/g, ' ');
