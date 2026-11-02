// npm run create-firm -- --name "Studio Rossi" --country IT
// npm run create-accountant -- --email elena@voixa.es --name "Elena Ruiz" [--firm "Voixa Accounting"]
// npm run login-link -- --email elena@voixa.es      (prints a one-time sign-in link)
// node src/cli.js list-firms
// node src/cli.js set-tier --firm "Studio Rossi" --tier pro      (essential | pro: Pro adds AI reading, bank feeds, email-in, exports)
import { parseArgs } from 'node:util';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { createLoginLink } from './auth.js';
import { config } from './config.js';
import { COUNTRY_CODES, isCountry } from './countries.js';

const [cmd] = process.argv.slice(2);
const { values } = parseArgs({ args: process.argv.slice(3), options: {
  email: { type: 'string' }, name: { type: 'string' }, firm: { type: 'string' }, country: { type: 'string' }, tier: { type: 'string' },
} });
const email = (values.email || '').trim().toLowerCase();
const country = (values.country || '').trim().toUpperCase();

async function findFirm(ref) {
  const { rows } = await pool.query(
    `select * from firms where id::text = $1 or lower(name) = lower($1) order by created_at`, [ref]);
  if (!rows.length) throw new Error(`No firm "${ref}". Create it with: npm run create-firm -- --name "${ref}" --country ES`);
  return rows[0];
}

async function createFirm(name, cc) {
  if (!name) throw new Error('Pass --name');
  if (!isCountry(cc)) throw new Error(`Pass --country, one of: ${COUNTRY_CODES.join(', ')}`);
  const tier = values.tier || 'essential';
  if (!['essential', 'pro'].includes(tier)) throw new Error('Pass --tier essential or --tier pro');
  const { rows: [f] } = await pool.query('insert into firms (name, country, tier) values ($1, $2, $3) returning *', [name, cc, tier]);
  return f;
}

try {
  await migrate();
  if (cmd === 'create-firm') {
    const f = await createFirm((values.name || '').trim(), country);
    console.log(`Firm created: ${f.name} (${f.country}), plan ${f.tier}, id ${f.id}`);
    console.log(`Add an accountant: npm run create-accountant -- --firm "${f.name}" --email someone@example.com --name "Their Name"`);
  } else if (cmd === 'verify-all') {
    // check every client's log: used after restoring a backup (deploy/restore-test.sh)
    const { verifyCompany } = await import('./ledger.js');
    const { rows } = await pool.query('select id, no, name, firm_id from companies order by firm_id, no');
    let bad = 0, entries = 0;
    for (const c of rows) {
      const v = await verifyCompany(pool, c.id);
      entries += v.count || 0;
      if (!v.ok) { bad++; console.log(`BROKEN  #${c.no} ${c.name}: ${v.reason}`); }
    }
    const counts = (await pool.query(`select (select count(*) from firms) as firms, (select count(*) from items) as items, (select count(*) from versions) as files`)).rows[0];
    console.log(`${rows.length} clients, ${entries} log entries, ${counts.items} items, ${counts.files} file versions, ${counts.firms} firms: ${bad ? `${bad} BROKEN` : 'every log verifies'}`);
    if (bad) process.exitCode = 2;
  } else if (cmd === 'set-tier') {
    if (!['essential', 'pro'].includes(values.tier)) throw new Error('Pass --tier essential or --tier pro');
    const f = await findFirm(values.firm || '');
    await pool.query('update firms set tier = $2 where id = $1', [f.id, values.tier]);
    console.log(`${f.name}: plan ${values.tier === 'pro' ? 'Pro (AI reading, bank feeds, email-in, exports)' : 'Essential'}`);
  } else if (cmd === 'list-firms') {
    const { rows } = await pool.query(`select f.*, (select count(*) from companies c where c.firm_id = f.id)::int as clients,
      (select count(*) from users u where u.firm_id = f.id)::int as accountants from firms f order by created_at`);
    for (const f of rows) console.log(`${f.id}  ${f.country}  ${f.tier.padEnd(8)}  ${f.name}  (${f.accountants} accountants, ${f.clients} clients)`);
    if (!rows.length) console.log('No firms yet.');
  } else {
    if (!email) throw new Error('Pass --email');
    if (cmd === 'create-accountant') {
      let firm;
      if (values.firm) firm = await findFirm(values.firm);
      else {
        const { rows } = await pool.query('select * from firms order by created_at');
        if (rows.length > 1) throw new Error(`There are ${rows.length} firms. Say which one with --firm (see: node src/cli.js list-firms)`);
        firm = rows[0] || await createFirm(config.firmName, country || 'ES');
      }
      const { rows: [existing] } = await pool.query('select * from users where email = $1', [email]);
      if (existing && existing.role !== 'accountant') throw new Error(`${email} already exists as a client`);
      if (existing && existing.firm_id && existing.firm_id !== firm.id) throw new Error(`${email} is already an accountant at another firm`);
      const { rows: [u] } = await pool.query(
        `insert into users (email, name, role, firm_id) values ($1, $2, 'accountant', $3)
         on conflict (email) do update set name = coalesce(nullif($2, ''), users.name), firm_id = $3 returning *`, [email, values.name || '', firm.id]);
      console.log(`Accountant ready: ${u.name || u.email}, ${firm.name} (${firm.country})`);
      console.log(`Sign-in link (valid once): ${await createLoginLink(u.id)}`);
    } else if (cmd === 'login-link') {
      const { rows: [u] } = await pool.query('select * from users where email = $1', [email]);
      if (!u) throw new Error(`No user ${email}`);
      console.log(await createLoginLink(u.id));
    } else {
      throw new Error('Commands: create-firm, list-firms, set-tier, create-accountant, login-link, verify-all');
    }
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
