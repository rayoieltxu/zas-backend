require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000);
  await pool.query(
    `INSERT INTO moment_windows (date, started_at, expires_at, notified)
     VALUES (CURRENT_DATE, $1, $2, true)
     ON CONFLICT (date) DO UPDATE SET started_at=$1, expires_at=$2`,
    [now, expires]
  );
  console.log('✅ Ventana abierta, tienes 5 minutos hasta', expires.toISOString());
  await pool.end();
}

run().catch(e => { console.error(e.message); pool.end(); });
