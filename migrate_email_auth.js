require('dotenv').config();
const pool = require('./db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running email auth migration...');
    await client.query(`
      -- Añadir columnas de autenticación por email a users
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email           VARCHAR(255) UNIQUE,
        ADD COLUMN IF NOT EXISTS password_hash   VARCHAR(255),
        ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS verify_token    VARCHAR(64),
        ADD COLUMN IF NOT EXISTS verify_expires  TIMESTAMP,
        ADD COLUMN IF NOT EXISTS reset_token     VARCHAR(64),
        ADD COLUMN IF NOT EXISTS reset_expires   TIMESTAMP;

      CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token);
      CREATE INDEX IF NOT EXISTS idx_users_reset_token  ON users(reset_token);
    `);
    console.log('✅ Email auth migration applied');
  } catch (err) {
    console.error('❌ Email auth migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
