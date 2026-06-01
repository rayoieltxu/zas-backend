/**
 * top3.js  —  Top 3 mensual por zona
 *
 * Fórmula: score = karma + (coins / 10) + (streak_dias * 50)
 *
 * Se calcula:
 *  - En tiempo real para mostrar el ranking actual (GET /top3?zone=)
 *  - Al final de cada mes (cron o llamada manual) para hacer snapshot permanente
 */

const pool = require('../db/pool');

// ─── Ranking en tiempo real ───────────────────────────────────────────────────
async function getLiveRanking(zone, limit = 10) {
  const prefix = zone.slice(0, 5);

  const result = await pool.query(
    `SELECT
       u.id,
       u.public_name,
       u.karma,
       u.school_id,
       COALESCE(uc.coins, 0)             AS coins,
       COALESCE(us.current_streak, 0)    AS current_streak,
       COALESCE(s.name, NULL)            AS school_name,
       (
         u.karma
         + FLOOR(COALESCE(uc.coins, 0) / 10)
         + COALESCE(us.current_streak, 0) * 50
       )::INT                            AS score
     FROM users u
     LEFT JOIN user_coins   uc ON uc.user_id = u.id
     LEFT JOIN user_streaks us ON us.user_id = u.id
     LEFT JOIN schools       s ON s.id = u.school_id
     WHERE u.current_geohash LIKE $1
       AND u.last_active > NOW() - INTERVAL '30 days'
     ORDER BY score DESC
     LIMIT $2`,
    [`${prefix}%`, limit]
  );

  return result.rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

// ─── Snapshot mensual (llamar el último día del mes) ─────────────────────────
// Guarda el top 3 de cada zona activa y otorga recompensas.
async function runMonthlySnapshot(pool) {
  const now        = new Date();
  const periodKey  = now.toISOString().slice(0, 7); // 'YYYY-MM'

  // Obtener todas las zonas activas (prefijo de 5 chars)
  const zonesResult = await pool.query(
    `SELECT DISTINCT LEFT(current_geohash, 5) AS zone_prefix
     FROM users
     WHERE last_active > NOW() - INTERVAL '30 days'`
  );

  let totalSnapshots = 0;

  for (const { zone_prefix } of zonesResult.rows) {
    const ranking = await getLiveRanking(zone_prefix, 3);
    if (ranking.length === 0) continue;

    for (const entry of ranking) {
      // Guardar snapshot
      await pool.query(
        `INSERT INTO monthly_top (user_id, zone_geohash, period_key, rank, score)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (zone_geohash, period_key, rank) DO UPDATE
           SET user_id = $1, score = $5`,
        [entry.id, zone_prefix, periodKey, entry.rank, entry.score]
      );

      // Recompensas solo al top 3
      const rewardCoins = entry.rank === 1 ? 500 : entry.rank === 2 ? 300 : 150;
      const rewardKarma = entry.rank === 1 ? 100 : entry.rank === 2 ?  60 :  30;

      await pool.query(
        `INSERT INTO user_coins (user_id, coins) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET coins = user_coins.coins + $2, updated_at = NOW()`,
        [entry.id, rewardCoins]
      );
      await pool.query(
        `INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1, $2, 'monthly_top')`,
        [entry.id, rewardCoins]
      );
      await pool.query(
        'UPDATE users SET karma = karma + $1 WHERE id = $2',
        [rewardKarma, entry.id]
      );

      totalSnapshots++;
    }
  }

  console.log(`📊 Monthly snapshot done: ${totalSnapshots} entries across ${zonesResult.rows.length} zones`);
  return totalSnapshots;
}

// ─── Top 3 histórico de una zona ─────────────────────────────────────────────
async function getHistoricTop3(zone, periodKey) {
  const prefix = zone.slice(0, 5);

  const result = await pool.query(
    `SELECT
       mt.rank, mt.score, mt.period_key, mt.social_links,
       u.public_name, u.karma,
       s.name AS school_name
     FROM monthly_top mt
     JOIN users u ON u.id = mt.user_id
     LEFT JOIN schools s ON s.id = u.school_id
     WHERE mt.zone_geohash = $1
       AND mt.period_key = $2
     ORDER BY mt.rank ASC`,
    [prefix, periodKey]
  );

  return result.rows;
}

// ─── Actualizar social links del ganador ─────────────────────────────────────
async function updateSocialLinks(userId, zone, periodKey, socialLinks) {
  const prefix = zone.slice(0, 5);

  const result = await pool.query(
    `UPDATE monthly_top
     SET social_links = $1
     WHERE user_id = $2 AND zone_geohash = $3 AND period_key = $4
     RETURNING rank`,
    [JSON.stringify(socialLinks), userId, prefix, periodKey]
  );

  if (result.rows.length === 0) {
    throw new Error('NOT_IN_TOP3');
  }
  return result.rows[0];
}

module.exports = { getLiveRanking, runMonthlySnapshot, getHistoricTop3, updateSocialLinks };
