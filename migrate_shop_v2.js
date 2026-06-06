/**
 * migrate_shop_v2.js — Añade más items a la tienda
 * Ejecutar: node migrate_shop_v2.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const NEW_ITEMS = [
  // ── FRAMES (marcos de avatar) ──────────────────────────────────────
  { name: 'Marco Fuego',       type: 'frame',      icon: '🔥', price: 120, rarity: 'rare',      description: 'Marco de llamas para tu avatar' },
  { name: 'Marco Galaxia',     type: 'frame',      icon: '🌌', price: 200, rarity: 'epic',      description: 'Un marco del cosmos para elegidos' },
  { name: 'Marco Rainbow',     type: 'frame',      icon: '🌈', price: 150, rarity: 'rare',      description: 'Siete colores para tu perfil' },
  { name: 'Marco VIP',         type: 'frame',      icon: '💎', price: 500, rarity: 'legendary', description: 'Solo para los más poderosos de la zona' },

  // ── BADGES (insignias) ─────────────────────────────────────────────
  { name: 'Badge Fundador',    type: 'badge',      icon: '🏛️', price: 0,   rarity: 'legendary', description: 'Reservado a los primeros en llegar' },
  { name: 'Badge Leyenda',     type: 'badge',      icon: '⚡', price: 300, rarity: 'epic',      description: 'Para quienes acumulan karma de élite' },
  { name: 'Badge Chismoso',    type: 'badge',      icon: '👀', price: 80,  rarity: 'uncommon',  description: 'Siempre pendiente del barrio' },
  { name: 'Badge Nocturno',    type: 'badge',      icon: '🦉', price: 90,  rarity: 'uncommon',  description: 'Activo cuando todos duermen' },
  { name: 'Badge Paparazzi',   type: 'badge',      icon: '📸', price: 100, rarity: 'uncommon',  description: 'El que más stories sube en la zona' },

  // ── TITLES (títulos) ───────────────────────────────────────────────
  { name: 'El Alcalde',        type: 'title',      icon: '🏛️', price: 250, rarity: 'epic',      description: 'Manda en la zona' },
  { name: 'La Leyenda',        type: 'title',      icon: '⚡', price: 250, rarity: 'epic',      description: 'Su karma habla por sí solo' },
  { name: 'El Fantasma',       type: 'title',      icon: '👻', price: 120, rarity: 'rare',      description: 'Está pero no se le ve' },
  { name: 'El Cotilla',        type: 'title',      icon: '🗣️', price: 80,  rarity: 'uncommon',  description: 'Sabe todo lo que pasa' },
  { name: 'El Insider',        type: 'title',      icon: '🔍', price: 90,  rarity: 'uncommon',  description: 'Siempre tiene info exclusiva' },
  { name: 'Zona VIP',          type: 'title',      icon: '💎', price: 400, rarity: 'legendary', description: 'Acceso ilimitado al barrio' },

  // ── EMOJI PACKS ────────────────────────────────────────────────────
  { name: 'Pack Animales',     type: 'emoji_pack', icon: '🐾', price: 60,  rarity: 'common',    description: 'Reacciona con animales del barrio' },
  { name: 'Pack Comida',       type: 'emoji_pack', icon: '🍕', price: 60,  rarity: 'common',    description: 'Emojis de la gastronomía local' },
  { name: 'Pack Clima',        type: 'emoji_pack', icon: '⛈️', price: 70,  rarity: 'uncommon',  description: 'El tiempo en emojis' },
  { name: 'Pack Épico',        type: 'emoji_pack', icon: '🔥', price: 150, rarity: 'epic',      description: 'Los emojis más salvajes de la zona' },
];

async function run() {
  const client = await pool.connect();
  try {
    let added = 0;
    for (const item of NEW_ITEMS) {
      const exists = await client.query(
        'SELECT 1 FROM shop_items WHERE name=$1', [item.name]
      );
      if (exists.rows.length === 0) {
        await client.query(
          `INSERT INTO shop_items (name, type, icon, price, rarity, description)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [item.name, item.type, item.icon, item.price, item.rarity, item.description]
        );
        console.log(`✅ Añadido: ${item.icon} ${item.name} (${item.rarity})`);
        added++;
      } else {
        console.log(`⏭️  Ya existe: ${item.name}`);
      }
    }
    console.log(`\n🎉 Migración completada. ${added} items nuevos añadidos.`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
