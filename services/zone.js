/**
 * services/zone.js — Alcalde de zona, Karma decay, Zona en llamas con push
 */
const pool = require('../db/pool');
const { sendPush } = require('./push');

// ── Alcalde de zona ───────────────────────────────────────────────────────────
// Devuelve el usuario con más karma ganado en los últimos 7 días en una zona
async function getZoneMayor(zone4) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.public_name, u.avatar_url, u.karma,
              COUNT(p.id)::int AS post_count
       FROM posts p
       JOIN users u ON u.id = p.user_id
       WHERE LEFT(p.geohash_zone, 4) = $1
         AND p.created_at > NOW() - INTERVAL '7 days'
       GROUP BY u.id, u.public_name, u.avatar_url, u.karma
       ORDER BY post_count DESC, u.karma DESC
       LIMIT 1`,
      [zone4]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('getZoneMayor error:', err.message);
    return null;
  }
}

// ── Zona en llamas (con push a usuarios de la zona) ───────────────────────────
// Se llama desde el cron cada 5 min. Si zona activa → push a usuarios de la zona
// que lleven al menos 10 min sin recibir este push (evitar spam)
const lastFlamePush = {}; // geohash4 → timestamp

async function checkZonaEnLlamas() {
  try {
    // Zonas con ≥5 posts en la última hora
    const { rows: activeZones } = await pool.query(
      `SELECT LEFT(geohash_zone, 4) AS zone, COUNT(*) AS cnt
       FROM posts
       WHERE created_at > NOW() - INTERVAL '1 hour'
       GROUP BY zone
       HAVING COUNT(*) >= 5`
    );

    for (const { zone } of activeZones) {
      const now = Date.now();
      // No spamear: mínimo 30 min entre pushes de la misma zona
      if (lastFlamePush[zone] && now - lastFlamePush[zone] < 30 * 60_000) continue;
      lastFlamePush[zone] = now;

      // Usuarios en esa zona que no hayan recibido el push recientemente
      const { rows: users } = await pool.query(
        `SELECT id FROM users WHERE LEFT(current_geohash, 4) = $1 LIMIT 200`,
        [zone]
      );

      for (const { id } of users) {
        sendPush(id, {
          title: '🔥 ¡Tu zona está en llamas!',
          body: 'Hay mucha actividad ahora mismo. ¡Únete!',
        });
      }
      console.log(`🔥 Zona en llamas push enviado a ${users.length} usuarios en zona ${zone}`);
    }
  } catch (err) {
    console.error('checkZonaEnLlamas error:', err.message);
  }
}

// ── Karma decay ───────────────────────────────────────────────────────────────
// Cada semana, usuarios sin actividad en 7 días pierden el 3% de karma (mín 1 punto)
// Se ejecuta una vez a la semana
async function applyKarmaDecay() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE users
       SET karma = GREATEST(0, karma - GREATEST(1, FLOOR(karma * 0.03)::int))
       WHERE karma > 0
         AND id NOT IN (
           SELECT DISTINCT user_id FROM posts
           WHERE created_at > NOW() - INTERVAL '7 days'
         )
         AND id NOT IN (
           SELECT DISTINCT user_id FROM reactions
           WHERE created_at > NOW() - INTERVAL '7 days'
         )`
    );
    console.log(`📉 Karma decay aplicado a ${rowCount} usuarios inactivos`);
  } catch (err) {
    console.error('applyKarmaDecay error:', err.message);
  }
}

module.exports = { getZoneMayor, checkZonaEnLlamas, applyKarmaDecay };
