require('dotenv').config();
const pool = require('./db/pool');
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS post_comments (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
        user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
        text       VARCHAR(500) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
    `);
    console.log('✅ post_comments table created');
  } catch (err) {
    console.error('❌', err.message); process.exit(1);
  } finally { client.release(); await pool.end(); }
}
migrate();
