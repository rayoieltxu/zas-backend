/**
 * migrate_moments_nullable_window.js
 * Hace window_id nullable en zas_moments para permitir subir momentos fuera de ventana bonus.
 * Ejecutar: node migrate_moments_nullable_window.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    // Hacer window_id nullable
    await client.query(`ALTER TABLE zas_moments ALTER COLUMN window_id DROP NOT NULL`);
    console.log('✅ window_id ahora es nullable en zas_moments');

    // Añadir columna location_name si no existe (por si acaso)
    await client.query(`ALTER TABLE zas_moments ADD COLUMN IF NOT EXISTS location_name TEXT`);
    console.log('✅ location_name OK');

    console.log('Migración completada.');
  } catch (err) {
    console.error('Error en migración:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
