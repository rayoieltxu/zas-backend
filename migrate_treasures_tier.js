require('dotenv').config();
const pool = require('./db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE treasures ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'chispa';
    `);
    // Actualizar la expiración a 7 días si no existe (por si la columna faltaba)
    await client.query(`
      ALTER TABLE treasures ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP
        DEFAULT NOW() + INTERVAL '7 days';
    `);
    console.log('✅ Treasure tier column added');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
