require('dotenv').config();
const pool = require('./db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔧 Adding reactions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS post_reactions (
        post_id   UUID REFERENCES posts(id) ON DELETE CASCADE,
        user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
        emoji     VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (post_id, user_id, emoji)
      );
      CREATE INDEX IF NOT EXISTS idx_reactions_post ON post_reactions(post_id);
    `);
    console.log('✅ Reactions table created');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
