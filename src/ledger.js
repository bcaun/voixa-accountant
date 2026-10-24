// The evidence log. Every action on a company's workspace becomes one event.
// Each event's hash covers its own content and the previous event's hash, so
// editing, reordering or deleting any past row breaks verification.
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const genesis = (companyId) => `GENESIS-${companyId}`;

// JSON with sorted object keys, so the same value always hashes the same way
// whatever order jsonb hands the keys back in.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

export function eventHash(prev, e) {
  const at = e.at instanceof Date ? e.at.toISOString() : e.at;
  return sha256(prev + '|' + canonical([
    e.company_id, e.seq, at, e.actor_type, e.actor_id ?? null, e.actor_name,
    e.type, e.item_id ?? null, e.version_id ?? null, e.text, e.data ?? {},
  ]));
}

/**
 * Append one event inside an open transaction. Locks the company row, so
 * concurrent writers to the same company are serialised and the chain never forks.
 */
export async function appendEvent(client, ev) {
  const { rows: [head] } = await client.query(
    'select head_seq, head_hash from companies where id = $1 for update', [ev.companyId]);
  if (!head) throw new Error(`company ${ev.companyId} not found`);
  const row = {
    company_id: ev.companyId,
    seq: head.head_seq + 1,
    at: new Date(),
    actor_type: ev.actor.type,
    actor_id: ev.actor.id ?? null,
    actor_name: ev.actor.name,
    type: ev.type,
    item_id: ev.itemId ?? null,
    version_id: ev.versionId ?? null,
    text: ev.text,
    // round-trip through JSON so the hash covers exactly what jsonb stores (Dates become strings)
    data: JSON.parse(JSON.stringify(ev.data ?? {})),
  };
  row.prev_hash = head.head_hash || genesis(ev.companyId);
  row.hash = eventHash(row.prev_hash, row);
  const { rows: [saved] } = await client.query(
    `insert into events (company_id, seq, at, actor_type, actor_id, actor_name, type, item_id, version_id, text, data, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [row.company_id, row.seq, row.at, row.actor_type, row.actor_id, row.actor_name, row.type,
      row.item_id, row.version_id, row.text, JSON.stringify(row.data), row.prev_hash, row.hash]);
  await client.query('update companies set head_seq = $2, head_hash = $3 where id = $1',
    [ev.companyId, row.seq, row.hash]);
  return saved;
}

/** Recompute the whole chain of one company. */
export async function verifyCompany(db, companyId) {
  const { rows } = await db.query('select * from events where company_id = $1 order by seq', [companyId]);
  const { rows: [head] } = await db.query('select head_seq, head_hash from companies where id = $1', [companyId]);
  let prev = genesis(companyId);
  let expectSeq = 1;
  for (const e of rows) {
    if (e.seq !== expectSeq) return { ok: false, count: rows.length, brokenSeq: expectSeq, reason: `entry ${expectSeq} is missing` };
    if (e.prev_hash !== prev || eventHash(prev, e) !== e.hash) {
      return { ok: false, count: rows.length, brokenSeq: e.seq, reason: `entry ${e.seq} does not match its hash` };
    }
    prev = e.hash;
    expectSeq++;
  }
  if (head && head.head_seq !== rows.length) {
    return { ok: false, count: rows.length, brokenSeq: rows.length + 1, reason: 'the newest entries are missing' };
  }
  return { ok: true, count: rows.length, headHash: rows.length ? prev : null };
}
