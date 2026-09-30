import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.NODE_ENV === 'production' ? { ssl: { rejectUnauthorized: true } } : {}),
  max: Number(process.env.PG_POOL_SIZE ?? 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
pool.on('error', (error: Error) => console.error('Unexpected idle database client error', error.message));
