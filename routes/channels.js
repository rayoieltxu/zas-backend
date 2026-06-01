const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { spendCoins } = require('../services/economy');

// ─── GET /channels?zone= ──────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const zone   = req.query.zone || req.user.current_geohash;
  const prefix = zone.slice(0, 5);

  try {
    const result = await pool.query(
      `SELECT
         c.id, c.name, c.description, c.created_at, c.last_active,
         u.public_name   AS owner_name,
         COUNT(cm.user_id)::INT AS member_count,
         MAX(CASE WHEN cm.user_id = $1 THEN 1 ELSE 0 END)::BOOLEAN AS is_member,
         MAX(CASE WHEN cm.user_id = $1 AND cm.is_moderator THEN 1 ELSE 0 END)::BOOLEAN AS is_moderator,
         (c.owner_id = $1) AS is_owner
       FROM channels c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN channel_members cm ON cm.channel_id = c.id
       WHERE c.zone_geohash LIKE $2
       GROUP BY c.id, u.public_name
       ORDER BY c.last_active DESC
       LIMIT 50`,
      [req.user.id, `${prefix}%`]
    );
    res.json({ channels: result.rows });
  } catch (err) {
    console.error('GET /channels error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /channels → crear canal (200 monedas) ───────────────────────────────
router.post('/', auth, async (req, res) => {
  const { name, description } = req.body;

  if (!name || name.trim().length < 2 || name.trim().length > 50)
    return res.status(400).json({ error: 'name must be 2–50 chars' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await spendCoins(req.user.id, 'create_channel', client);

    const result = await client.query(
      `INSERT INTO channels (name, description, owner_id, zone_geohash)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), description?.trim() || null, req.user.id, req.user.current_geohash]
    );
    const channel = result.rows[0];

    // El creador entra automáticamente como moderador
    await client.query(
      `INSERT INTO channel_members (channel_id, user_id, is_moderator) VALUES ($1, $2, true)`,
      [channel.id, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ channel: { ...channel, member_count: 1, is_member: true, is_moderator: true, is_owner: true } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message === 'INSUFFICIENT_COINS')
      return res.status(402).json({ error: 'Necesitas 200 monedas para crear un canal' });
    console.error('POST /channels error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── POST /channels/:id/join ──────────────────────────────────────────────────
router.post('/:id/join', auth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id]
    );
    await pool.query(
      `UPDATE channels SET last_active = NOW() WHERE id = $1`, [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /channels/:id/leave ───────────────────────────────────────────────
router.delete('/:id/leave', auth, async (req, res) => {
  try {
    // Comprobar si es owner
    const ch = await pool.query('SELECT owner_id FROM channels WHERE id = $1', [req.params.id]);
    if (ch.rows[0]?.owner_id === req.user.id)
      return res.status(400).json({ error: 'El owner no puede abandonar el canal. Transfiere la propiedad o bórralo.' });

    await pool.query(
      `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /channels/:id → borrar canal (solo owner) ───────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM channels WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Canal no encontrado o no eres el owner' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /channels/:id/members/:userId → expulsar (moderador) ─────────────
router.delete('/:id/members/:userId', auth, async (req, res) => {
  try {
    // Verificar que el que pide es moderador u owner
    const modCheck = await pool.query(
      `SELECT cm.is_moderator, c.owner_id
       FROM channel_members cm
       JOIN channels c ON c.id = cm.channel_id
       WHERE cm.channel_id = $1 AND cm.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (modCheck.rows.length === 0 || (!modCheck.rows[0].is_moderator && modCheck.rows[0].owner_id !== req.user.id))
      return res.status(403).json({ error: 'No tienes permisos de moderación' });

    await pool.query(
      `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /channels/:id/messages?limit=50 ─────────────────────────────────────
router.get('/:id/messages', auth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  // Verificar membresía
  const member = await pool.query(
    `SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (member.rows.length === 0)
    return res.status(403).json({ error: 'No eres miembro de este canal' });

  try {
    const result = await pool.query(
      `SELECT
         m.id, m.text, m.created_at,
         u.public_name AS author_name,
         u.id          AS user_id
       FROM channel_messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = $1
         AND m.created_at > NOW() - INTERVAL '7 days'
       ORDER BY m.created_at ASC
       LIMIT $2`,
      [req.params.id, limit]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /channels/:id/messages → enviar mensaje ────────────────────────────
router.post('/:id/messages', auth, async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length === 0 || text.length > 500)
    return res.status(400).json({ error: 'text required, max 500 chars' });

  // Verificar membresía
  const member = await pool.query(
    `SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (member.rows.length === 0)
    return res.status(403).json({ error: 'No eres miembro de este canal' });

  try {
    const result = await pool.query(
      `INSERT INTO channel_messages (channel_id, user_id, text) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.user.id, text.trim()]
    );
    await pool.query(`UPDATE channels SET last_active = NOW() WHERE id = $1`, [req.params.id]);

    const msg = {
      ...result.rows[0],
      author_name: req.user.public_name,
    };
    res.status(201).json({ message: msg });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
