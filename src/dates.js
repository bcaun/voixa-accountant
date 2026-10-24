// Deadlines are end of day in Madrid, the jurisdiction the filings belong to.
const TZ = 'Europe/Madrid';

function offsetMs(utcMs) {
  const d = new Date(utcMs);
  const local = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return local - utc;
}

/** 23:59:59 Madrid time on the given calendar day (month is 0-based), as a Date. */
export function madridEndOfDay(y, m, d) {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const guess = Date.UTC(y, m, Math.min(d, last), 23, 59, 59);
  return new Date(guess - offsetMs(guess));
}

/** "2026-11-05" → end of that day in Madrid. Returns null for anything else. */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return madridEndOfDay(+m[1], +m[2] - 1, +m[3]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Due dates of a recurring obligation and the period each one covers.
 * monthly:   day N of every month, for the previous month
 * quarterly: day N of January, April, July and October, for the quarter just ended
 * yearly:    day N of month M, for the previous calendar year
 */
export function dueAfter(ob, from) {
  const f = new Date(from);
  let y = f.getUTCFullYear();
  let m = f.getUTCMonth();
  for (let i = 0; i < 30; i++) {
    let candidate = null;
    if (ob.frequency === 'monthly') candidate = { y, m };
    else if (ob.frequency === 'quarterly' && m % 3 === 0) candidate = { y, m };
    else if (ob.frequency === 'yearly' && m === (ob.due_month ?? 1) - 1) candidate = { y, m };
    if (candidate) {
      const due = madridEndOfDay(candidate.y, candidate.m, ob.due_day);
      if (due >= f) return { due, ...periodFor(ob.frequency, candidate.y, candidate.m) };
    }
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return null;
}

function periodFor(frequency, y, m) {
  if (frequency === 'monthly') {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    return { period: `${py}-${String(pm + 1).padStart(2, '0')}`, periodLabel: `${MONTHS[pm]} ${py}` };
  }
  if (frequency === 'quarterly') {
    const q = m === 0 ? 4 : m / 3;
    const qy = m === 0 ? y - 1 : y;
    return { period: `${qy}-Q${q}`, periodLabel: `Q${q} ${qy}` };
  }
  return { period: String(y - 1), periodLabel: String(y - 1) };
}

export const fmtDay = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
export const fmtTime = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ, timeZoneName: 'short' });
