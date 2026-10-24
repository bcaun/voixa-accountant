// npm run create-accountant -- --email elena@voixa.es --name "Elena Ruiz"
// npm run login-link -- --email elena@voixa.es      (prints a one-time sign-in link)
import { parseArgs } from 'node:util';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { createLoginLink } from './auth.js';

const [cmd] = process.argv.slice(2);
const { values } = parseArgs({ args: process.argv.slice(3), options: { email: { type: 'string' }, name: { type: 'string' } } });
const email = (values.email || '').trim().toLowerCase();

try {
  await migrate();
  if (!email) throw new Error('Pass --email');
  if (cmd === 'create-accountant') {
    const { rows: [u] } = await pool.query(
      `insert into users (email, name, role) values ($1, $2, 'accountant')
       on conflict (email) do update set name = coalesce(nullif($2, ''), users.name) returning *`, [email, values.name || '']);
    if (u.role !== 'accountant') throw new Error(`${email} already exists as a client`);
    console.log(`Accountant ready: ${u.name || u.email}`);
    console.log(`Sign-in link (valid once): ${await createLoginLink(u.id)}`);
  } else if (cmd === 'login-link') {
    const { rows: [u] } = await pool.query('select * from users where email = $1', [email]);
    if (!u) throw new Error(`No user ${email}`);
    console.log(await createLoginLink(u.id));
  } else {
    throw new Error('Commands: create-accountant, login-link');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
