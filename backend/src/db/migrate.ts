import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  const sql = await readFile(path.resolve(here, '../../migrations/001_initial.sql'), 'utf8');
  await pool.query(sql);
  console.log('Database schema is up to date.');
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await pool.end(); }
