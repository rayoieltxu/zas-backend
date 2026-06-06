/**
 * routes/wars.js — Clan Wars
 * GET  /wars             — guerra activa de la zona actual
 * GET  /wars/history     — guerras pasadas
 * POST /wars/start       — iniciar guerra semanal (llamada interna / admin)
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');

// ── Obtener o crear guerra activa para la zona ─────────────────────────────────
async function getOrCreateWar(zonePrefix, poolClient) {
  const q = poolClient || pool;
  // Semana actual: lunes al domingo
  const now       = new Date();
  const dayOfWeek = now.getDay() || 7; // lunes=1, domingo=7
  const monday    = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek - 1));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const weekStart = monday.toISOString().slice(0, 10);
  const weekEnd   = sunday.toISOString().slice(0, 10);

  // Buscar guerra existente
  let warResult = await q.query(
    `SELECT * FROM clan_wars WHERE zone_prefix=$1 AND week_start=$2`,
    [zonePrefix, weekStart]
  );

  if (warResult.rows.length === 0) {
    // Finalizar guerra anterior si existe
    await q.query(
      `UPDATE clan_wars SET status='finished',
         winner_clan=(
           SELECT clan_id FROM clan_war_scores
           WHERE war_id=(SELECT id FROM clan_wars WHERE zone_prefix=$1 AND status='active' LIMIT 1)
           ORDER BY points DESC LIMIT 1
         )
       WHERE zone_prefix=$1 AND status='active'`,
      [zonePrefix]
    );
    // Crear nueva guerra
    const inserted = await q.query(
      `INSERT INTO clan_wars (zone_prefix, week_start, week_end, status)
       VALUES ($1,$2,$3,'active') RETURNING *`,
      [zonePrefix, weekStart, weekEnd]
    );
    warResult = { rows: inserted.rows };
  }
  return warResult.rows[0];
}

// GET /wars?zone=
router.get('/', auth, async (req, res) => {
  const zone       = req.query.zone || req.user.current_geohash;
  const zonePrefix = zone.slice(0, 5);

  try {
    const war = await getOrCreateWar(zonePrefix);

    // Scores de los clanes participantes
    const scores = await pool.query(
      `SELECT
         cws.clan_id, cws.points,
         cl.name AS clan_name, cl.tag AS clan_tag,
         cl.wars_won,
         u.public_name AS leader_name,
         COUNT(cm.user_id)::int AS member_count,
         EXISTS(SELECT 1 FROM clan_members WHERE clan_id=cws.clan_id AND user_id=$2) AS is_my_clan
       FROM clan_war_scores cws
       JOIN clans cl ON cl.id=cws.clan_id
       LEFT JOIN users u ON u.id=cl.leader_id
       LEFT JOIN clan_members cm ON cm.clan_id=cws.clan_id
       WHERE cws.war_id=$1
       GROUP BY cws.clan_id, cws.points, cl.name, cl.tag, cl.wars_won, u.public_name
       ORDER BY cws.points DESC`,
      [war.id, req.user.id]
    );

    // Buscar mi clan en la zona para añadirlo si no está en la guerra
    const myClan = await pool.query(
      `SELECT cl.id, cl.name, cl.tag
       FROM clan_members cm
       JOIN clans cl ON cl.id=cm.clan_id
       WHERE cm.user_id=$1 AND cl.zone_geohash LIKE $2
       LIMIT 1`,
      [req.user.id, `${zonePrefix}%`]
    );

    // Si tengo clan y no está en la guerra, añadirlo con 0 puntos
    if (myClan.rows.length > 0) {
      const clanId = myClan.rows[0].id;
      await pool.query(
        `INSERT INTO clan_war_scores (war_id, clan_id, points) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`,
        [war.id, clanId]
      );
    }

    // Top 3 histórico (guerras ganadas)
    const historical = await pool.query(
      `SELECT cl.id, cl.name, cl.tag, cl.wars_won, cl.total_war_points
       FROM clans cl
       WHERE cl.zone_geohash LIKE $1
       ORDER BY cl.wars_won DESC, cl.total_war_points DESC
       LIMIT 5`,
      [`${zonePrefix}%`]
    );

    res.json({
      war,
      scores:     scores.rows,
      historical: historical.rows,
      my_clan:    myClan.rows[0] || null,
    });
  } catch (err) {
    console.error('Wars GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Función interna: acreditar puntos de guerra a un clan ─────────────────────
async function awardWarPoints(userId, points) {
  try {
    // Buscar el clan del usuario
    const clanRes = await pool.query(
      `SELECT cl.id, cl.zone_geohash FROM clan_members cm
       JOIN clans cl ON cl.id=cm.clan_id
       WHERE cm.user_id=$1 LIMIT 1`,
      [userId]
    );
    if (!clanRes.rows.length) return;

    const clan = clanRes.rows[0];
    const zonePrefix = clan.zone_geohash.slice(0, 5);
    const war  = await getOrCreateWar(zonePrefix);

    await pool.query(
      `INSERT INTO clan_war_scores (war_id, clan_id, points) VALUES ($1,$2,$3)
       ON CONFLICT (war_id, clan_id) DO UPDATE SET points=clan_war_scores.points+$3`,
      [war.id, clan.id, points]
    );
  } catch (err) {
    console.error('awardWarPoints error:', err);
  }
}

// ── Cron: finalizar guerra y premiar al ganador ───────────────────────────────
async function finalizeWars() {
  try {
    // Guerras activas que ya pasaron su week_end
    const expired = await pool.query(
      `SELECT id, zone_prefix FROM clan_wars WHERE status='active' AND week_end < CURRENT_DATE`
    );

    for (const war of expired.rows) {
      const winner = await pool.query(
        `SELECT clan_id, points FROM clan_war_scores WHERE war_id=$1 ORDER BY points DESC LIMIT 1`,
        [war.id]
      );
      if (!winner.rows.length) continue;

      const winnerClanId = winner.rows[0].clan_id;

      // Actualizar guerra como finalizada
      await pool.query(
        `UPDATE clan_wars SET status='finished', winner_clan=$1 WHERE id=$2`,
        [winnerClanId, war.id]
      );

      // Incrementar wars_won y total_war_points
      await pool.query(
        `UPDATE clans SET wars_won=wars_won+1 WHERE id=$1`, [winnerClanId]
      );
      await pool.query(
        `UPDATE clans cl SET total_war_points=cl.total_war_points+cws.points
         FROM clan_war_scores cws
         WHERE cws.war_id=$1 AND cws.clan_id=cl.id`,
        [war.id]
      );

      // Premiar a los miembros del clan ganador con 100 monedas cada uno
      const members = await pool.query(
        `SELECT user_id FROM clan_members WHERE clan_id=$1`, [winnerClanId]
      );
      for (const m of members.rows) {
        await pool.query(
          `UPDATE user_coins SET coins=coins+100 WHERE user_id=$1`, [m.user_id]
        );
        await pool.query(
          `INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,100,'clan_war_win')`,
          [m.user_id]
        );
      }
      console.log(`🏆 Clan War finalizada: zona ${war.zone_prefix}, ganador clan ${winnerClanId}`);
    }
  } catch (err) {
    console.error('finalizeWars error:', err);
  }
}

module.exports = router;
module.exports.awardWarPoints = awardWarPoints;
module.exports.finalizeWars   = finalizeWars;
