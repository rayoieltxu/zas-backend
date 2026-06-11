const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');

// ─── GET /social/search?q=texto ──────────────────────────────────────────────
router.get('/search', auth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2)
    return res.status(400).json({ error: 'Mínimo 2 caracteres' });

  try {
    const result = await pool.query(
      `SELECT u.id, u.public_name, u.karma, u.avatar_url,
              COALESCE(us.current_streak, 0) AS current_streak,
              EXISTS(
                SELECT 1 FROM follows f
                WHERE f.follower_id = $1 AND f.following_id = u.id
              ) AS is_following
       FROM users u
       LEFT JOIN user_streaks us ON us.user_id = u.id
       WHERE u.public_name ILIKE $2
         AND u.id != $1
       ORDER BY u.karma DESC
       LIMIT 20`,
      [req.user.id, `%${q.trim()}%`]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /social/follow/:id ──────────────────────────────────────────────────
router.post('/follow/:id', auth, async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id)
    return res.status(400).json({ error: 'No puedes seguirte a ti mismo' });

  try {
    await pool.query(
      `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, targetId]
    );
    res.json({ ok: true, following: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /social/follow/:id ────────────────────────────────────────────────
router.delete('/follow/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM follows WHERE follower_id=$1 AND following_id=$2',
      [req.user.id, req.params.id]
    );
    res.json({ ok: true, following: false });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /social/followers/:id ────────────────────────────────────────────────
router.get('/followers/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.public_name, u.karma, u.avatar_url,
              EXISTS(SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=u.id) AS is_following
       FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = $2 ORDER BY f.created_at DESC LIMIT 50`,
      [req.user.id, req.params.id]
    );
    res.json({ followers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /social/following/:id ────────────────────────────────────────────────
router.get('/following/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.public_name, u.karma, u.avatar_url,
              EXISTS(SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=u.id) AS is_following
       FROM follows f JOIN users u ON u.id = f.following_id
       WHERE f.follower_id = $2 ORDER BY f.created_at DESC LIMIT 50`,
      [req.user.id, req.params.id]
    );
    res.json({ following: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /social/mutual/:id — seguidores en común ────────────────────────────
router.get('/mutual/:id', auth, async (req, res) => {
  try {
    // Gente que me sigue A MÍ y también sigue al :id
    const result = await pool.query(
      `SELECT u.id, u.public_name, u.karma, u.avatar_url,
              EXISTS(SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=u.id) AS is_following
       FROM follows f1
       JOIN follows f2 ON f2.follower_id = f1.follower_id AND f2.following_id = $2
       JOIN users u ON u.id = f1.follower_id
       WHERE f1.following_id = $1
         AND u.id != $1 AND u.id != $2
       ORDER BY u.karma DESC
       LIMIT 20`,
      [req.user.id, req.params.id]
    );
    res.json({ mutual: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
