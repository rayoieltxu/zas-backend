/**
 * migrate_momento_zas.js — El Momento ZAS (como BeReal pero geolocallizado)
 * Ejecutar: node migrate_momento_zas.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    // Ventanas diarias: una al día a hora aleatoria
    await client.query(`
      CREATE TABLE IF NOT EXISTS moment_windows (
        id          SERIAL PRIMARY KEY,
        date        DATE NOT NULL UNIQUE,       -- una sola ventana por día
        started_at  TIMESTAMPTZ NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,       -- started_at + 5 minutos
        notified    BOOLEAN DEFAULT false
      )
    `);
    console.log('✅ moment_windows');

    // Fotos subidas por usuarios en cada ventana
    await client.query(`
      CREATE TABLE IF NOT EXISTS zas_moments (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        window_id   INTEGER NOT NULL REFERENCES moment_windows(id),
        image_url   TEXT NOT NULL,
        caption     TEXT,
        zone        VARCHAR(20) NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        feed_until  TIMESTAMPTZ NOT NULL,       -- aparece en feed 24h
        UNIQUE(user_id, window_id)             -- una foto por ventana por usuario
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_moments_zone ON zas_moments(zone, feed_until)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_moments_user ON zas_moments(user_id, created_at DESC)`);
    console.log('✅ zas_moments');

    // Racha de momentos subidos a tiempo
    await client.query(`
      ALTER TABLE user_streaks
        ADD COLUMN IF NOT EXISTS momento_streak INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_momento   DATE
    `);
    console.log('✅ momento_streak en user_streaks');

    console.log('\n🎉 Migración completada.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
