require('dotenv').config();
const pool = require('./db/pool');
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS post_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        text VARCHAR(500) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id);

      CREATE TABLE IF NOT EXISTS direct_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_id UUID REFERENCES users(id) ON DELETE CASCADE,
        to_id   UUID REFERENCES users(id) ON DELETE CASCADE,
        text    VARCHAR(1000) NOT NULL,
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_dm_participants ON direct_messages(from_id, to_id);
      CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_id);
    `);
    console.log('✅ post_comments y direct_messages creadas');
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
