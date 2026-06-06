/**
 * migrate_gif_comments.js — Añade soporte de GIFs en comentarios
 * Ejecutar: node migrate_gif_comments.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE post_comments
        ADD COLUMN IF NOT EXISTS gif_url TEXT
    `);
    console.log('✅ gif_url añadido a post_comments');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
