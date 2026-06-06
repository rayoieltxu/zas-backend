require('dotenv').config();
const pool = require('./db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
        token    VARCHAR(300) NOT NULL,
        platform VARCHAR(10) DEFAULT 'android',
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id)
      );
    `);
    console.log('✅ push_tokens table created');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
