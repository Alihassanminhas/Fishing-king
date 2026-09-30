import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

const [name, email, password] = process.argv.slice(2);
if (!name || !email || !password || password.length < 12) {
  console.error('Usage: npm run admin:create -- "Admin Name" admin@example.com "12+ character password"');
  process.exitCode = 1;
} else {
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(`INSERT INTO users(name,email,password_hash,role) VALUES($1,lower($2),$3,'admin')
      ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,role='admin'`, [name, email, hash]);
    console.log(`Admin account ready for ${email.toLowerCase()}.`);
  } catch (error) { console.error('Admin setup failed:', error instanceof Error ? error.message : error); process.exitCode = 1; }
  finally { await pool.end(); }
}
