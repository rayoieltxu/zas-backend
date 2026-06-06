/**
 * routes/stories.js
 * GET  /stories        — stories activas de la zona (24 h)
 * POST /stories        — crear story (requiere imagen subida previamente)
 * POST /stories/:id/view — marcar como vista
 * DELETE /stories/:id  — borrar propia story
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');

// GET /stories?zone=xxxxx
router.get('/', auth, async (req, res) => {
  const zone       = req.query.zone || req.user.current_geohash;
  const zonePrefix = zone.slice(0, 5);
  try {
    const result = await pool.query(
      `SELECT
         s.id, s.image_url, s.caption, s.created_at, s.expires_at,
         s.user_id,
         u.public_name AS author_name,
         u.avatar_url  AS author_avatar,
         COUNT(sv.user_id)::int AS views,
         BOOL_OR(sv.user_id = $1) AS seen
       FROM stories s
       LEFT JOIN users u ON s.user_id = u.id
       LEFT JOIN story_views sv ON sv.story_id = s.id
       WHERE s.geohash_zone LIKE $2
         AND s.expires_at > NOW()
       GROUP BY s.id, u.public_name, u.avatar_url
       ORDER BY s.created_at DESC`,
      [req.user.id, `${zonePrefix}%`]
    );
    res.json({ stories: result.rows });
  } catch (err) {
    console.error('Stories GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /stories — crear story
router.post('/', auth, async (req, res) => {
  const { image_url, caption } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url required' });
  if (req.user.is_visitor) return res.status(403).json({ error: 'Visitantes no pueden crear stories' });

  try {
    // Límite: máx 5 stories activas por usuario
    const { rows: active } = await pool.query(
      `SELECT COUNT(*) FROM stories WHERE user_id = $1 AND expires_at > NOW()`,
      [req.user.id]
    );
    if (parseInt(active[0].count) >= 5)
      return res.status(429).json({ error: 'Máximo 5 stories activas' });

    const result = await pool.query(
      `INSERT INTO stories (user_id, image_url, caption, geohash_zone)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.id, image_url, caption?.slice(0, 200) || null, req.user.current_geohash]
    );
    const story = {
      ...result.rows[0],
      author_name:   req.user.public_name,
      author_avatar: req.user.avatar_url || null,
      views: 0,
      seen:  false,
    };

    // Emitir en tiempo real
    const io = req.app.get('io');
    if (io) {
      io.to(`zone:${req.user.current_geohash.slice(0, 5)}`).emit('new_story', { story });
    }

    res.status(201).json({ story });
  } catch (err) {
    console.error('Stories POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /stories/:id/view — marcar vista
router.post('/:id/view', auth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO story_views (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /stories/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Story no encontrada o no es tuya' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
