import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { config } from './config.js';

const dir = fileURLToPath(new URL('./sql/', import.meta.url));

export async function migrate() {
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const sql = await readFile(dir + name, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      // migrations that need settings read them with current_setting('pescada.…')
      await client.query("select set_config('pescada.firm_name', $1, true)", [config.firmName]);
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [name]);
      await client.query('commit');
      console.log(`migrated ${name}`);
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch((err) => { console.error(err); process.exit(1); });
}
