import pg from 'pg';
import { config } from './config.js';

// bigint columns (seq, size) fit comfortably in a JS number here
pg.types.setTypeParser(20, (v) => Number(v));
// calendar dates stay 'YYYY-MM-DD' strings, never shifted by the server's time zone
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
