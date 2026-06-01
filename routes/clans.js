const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');

const MAX_CLAN_MEMBERS = 10;

// ─── GET /clans?zone= ─────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const zone   = req.query.zone || req.user.current_geohash;
  const prefix = zone.slice(0, 5);

  try {
    const result = await pool.query(
      `SELECT
         cl.id, cl.name, cl.tag, cl.description, cl.weekly_points, cl.created_at,
         u.public_name AS leader_name,
         COUNT(cm.user_id)::INT AS member_count,
         MAX(CASE WHEN cm.user_id = $1 THEN 1 ELSE 0 END)::BOOLEAN AS is_member,
         (cl.leader_id = $1) AS is_leader
       FROM clans cl
       LEFT JOIN users u ON u.id = cl.leader_id
       LEFT JOIN clan_members cm ON cm.clan_id = cl.id
       WHERE cl.zone_geohash LIKE $2
       GROUP BY cl.id, u.public_name
       ORDER BY cl.weekly_points DESC, cl.created_at DESC
       LIMIT 30`,
      [req.user.id, `${prefix}%`]
    );
    res.json({ clans: result.rows });
  } catch (err) {
    console.error('GET /clans error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /clans/mine → clan propio ───────────────────────────────────────────
router.get('/mine', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cl.*, u.public_name AS leader_name
       FROM clans cl
       JOIN clan_members cm ON cm.clan_id = cl.id
       LEFT JOIN users u ON u.id = cl.leader_id
       WHERE cm.user_id = $1
       LIMIT 1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.json({ clan: null });

    // Obtener miembros
    const members = await pool.query(
      `SELECT u.id, u.public_name, u.karma, COALESCE(uc.coins, 0) AS coins
       FROM clan_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN user_coins uc ON uc.user_id = u.id
       WHERE cm.clan_id = $1
       ORDER BY u.karma DESC`,
      [result.rows[0].id]
    );

    res.json({ clan: result.rows[0], members: members.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /clans → crear clan ─────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const { name, tag, description } = req.body;

  if (!name || name.trim().length < 2 || name.trim().length > 30)
    return res.status(400).json({ error: 'name must be 2–30 chars' });
  if (!tag || tag.trim().length < 2 || tag.trim().length > 6)
    return res.status(400).json({ error: 'tag must be 2–6 chars' });

  // Verificar que el usuario no está ya en un clan
  const existing = await pool.query(
    `SELECT 1 FROM clan_members WHERE user_id = $1`, [req.user.id]
  );
  if (existing.rows.length > 0)
    return res.status(409).json({ error: 'Ya perteneces a un clan. Abandónalo primero.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO clans (name, tag, description, leader_id, zone_geohash)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), tag.trim().toUpperCase(), description?.trim() || null, req.user.id, req.user.current_geohash]
    );

    await client.query(
      `INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2)`,
      [result.rows[0].id, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ clan: { ...result.rows[0], member_count: 1, is_member: true, is_leader: true } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505')
      return res.status(409).json({ error: 'Ya existe un clan con ese tag en esta zona' });
    console.error('POST /clans error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── POST /clans/:id/join ─────────────────────────────────────────────────────
router.post('/:id/join', auth, async (req, res) => {
  // Verificar que no está ya en otro clan
  const inClan = await pool.query(`SELECT 1 FROM clan_members WHERE user_id = $1`, [req.user.id]);
  if (inClan.rows.length > 0)
    return res.status(409).json({ error: 'Ya perteneces a un clan' });

  // Verificar límite de miembros
  const count = await pool.query(
    `SELECT COUNT(*)::INT AS cnt FROM clan_members WHERE clan_id = $1`, [req.params.id]
  );
  if (count.rows[0].cnt >= MAX_CLAN_MEMBERS)
    return res.status(409).json({ error: `El clan está lleno (máx ${MAX_CLAN_MEMBERS} miembros)` });

  try {
    await pool.query(
      `INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2)`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya eres miembro' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /clans/:id/leave ──────────────────────────────────────────────────
router.delete('/:id/leave', auth, async (req, res) => {
  try {
    const clan = await pool.query('SELECT leader_id FROM clans WHERE id = $1', [req.params.id]);
    if (clan.rows[0]?.leader_id === req.user.id)
      return res.status(400).json({ error: 'El líder no puede abandonar. Transfiere el liderazgo o disuelve el clan.' });

    await pool.query(`DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /clans/:id → disolver clan (solo líder) ──────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM clans WHERE id = $1 AND leader_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Clan no encontrado o no eres el líder' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /clans/:id/leader → transferir liderazgo ────────────────────────────
router.put('/:id/leader', auth, async (req, res) => {
  const { new_leader_id } = req.body;
  if (!new_leader_id) return res.status(400).json({ error: 'new_leader_id required' });

  try {
    const result = await pool.query(
      `UPDATE clans SET leader_id = $1 WHERE id = $2 AND leader_id = $3 RETURNING id`,
      [new_leader_id, req.params.id, req.user.id]
    );
    if (result.rows.length === 0)
      return res.status(403).json({ error: 'No eres el líder del clan' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Recalcular puntos semanales del clan (llamada interna / cron) ────────────
// Suma el karma de todos los miembros activos esta semana.
async function recalcWeeklyPoints(pool) {
  try {
    await pool.query(
      `UPDATE clans cl
       SET weekly_points = (
         SELECT COALESCE(SUM(u.karma), 0)
         FROM clan_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.clan_id = cl.id
           AND u.last_active > NOW() - INTERVAL '7 days'
       )`
    );
    console.log('🏆 Clan weekly points recalculated');
  } catch (err) {
    console.error('recalcWeeklyPoints error:', err);
  }
}

module.exports = router;
module.exports.recalcWeeklyPoints = recalcWeeklyPoints;
