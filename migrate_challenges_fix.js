require('dotenv').config();
const pool = require('./db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔧 Fixing user_challenges constraint...');
    await client.query(`
      -- Eliminar filas duplicadas si las hay (quedarse con la más reciente)
      DELETE FROM user_challenges a
      USING user_challenges b
      WHERE a.id > b.id
        AND a.user_id      = b.user_id
        AND a.challenge_id = b.challenge_id
        AND a.period_key   = b.period_key;

      -- Añadir constraint única si no existe
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'user_challenges_user_challenge_period_key'
        ) THEN
          ALTER TABLE user_challenges
            ADD CONSTRAINT user_challenges_user_challenge_period_key
            UNIQUE (user_id, challenge_id, period_key);
        END IF;
      END $$;
    `);
    console.log('✅ user_challenges constraint applied');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
