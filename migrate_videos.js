/**
 * migrate_videos.js
 * Añade video_url a posts para soporte de Reels
 * Ejecutar: node backend/migrate_videos.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    console.log('🎬 Añadiendo video_url a posts...');
    await client.query(`
      ALTER TABLE posts
        ADD COLUMN IF NOT EXISTS video_url TEXT,
        ADD COLUMN IF NOT EXISTS video_thumbnail TEXT;
    `);
    // Índice para buscar posts con vídeo rápido
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_video
        ON posts (geohash_zone, created_at DESC)
        WHERE video_url IS NOT NULL;
    `);
    console.log('✅ video_url y video_thumbnail añadidos correctamente');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
