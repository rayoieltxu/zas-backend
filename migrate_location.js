/**
 * migrate_location.js
 * Añade location_name a zas_moments
 * Ejecutar: node backend/migrate_location.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    console.log('🗺️  Añadiendo location_name a zas_moments...');
    await client.query(`
      ALTER TABLE zas_moments
        ADD COLUMN IF NOT EXISTS location_name TEXT;
    `);
    console.log('✅ location_name añadido correctamente');
  } catch (err) {
    console.error('❌ Error en migración:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
