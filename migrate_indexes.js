/**
 * migrate_indexes.js — Índices de rendimiento para ZAS V5
 * Ejecutar: node migrate_indexes.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    const indexes = [
      // Feed: zona + fecha (el más crítico)
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_zone_date
         ON posts (geohash_zone, created_at DESC)`,
      // Feed: usuario + fecha (perfil)
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_user_date
         ON posts (user_id, created_at DESC)`,
      // Reacciones por post
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reactions_post
         ON post_reactions (post_id)`,
      // Reacciones por usuario
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reactions_user
         ON post_reactions (user_id, created_at DESC)`,
      // Daily claims por usuario+día
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_daily_claims_user_day
         ON daily_claims (user_id, day)`,
      // Duelos por participantes
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_duels_challenger
         ON duels (challenger_id, status)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_duels_challenged
         ON duels (challenged_id, status)`,
      // Usuarios por geohash (zona en llamas)
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_geohash4
         ON users (LEFT(current_geohash, 4))`,
      // Logros de usuario
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_achievements_user
         ON user_achievements (user_id)`,
      // ZAS moments por usuario
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zas_moments_user
         ON zas_moments (user_id, created_at DESC)`,
    ];

    for (const sql of indexes) {
      const name = sql.match(/idx_\w+/)?.[0] || '?';
      try {
        await client.query(sql);
        console.log(`✅ ${name}`);
      } catch (err) {
        console.log(`⚠️  ${name}: ${err.message}`);
      }
    }
    console.log('🎉 Índices aplicados.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(console.error);
