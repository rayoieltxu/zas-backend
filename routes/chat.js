const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// GET /chat/history?zone=geohash&limit=100
router.get('/history', auth, async (req, res) => {
  const { zone, limit = 100 } = req.query;
  const targetZone = zone || req.user.current_geohash;
  const safeLimit = Math.min(parseInt(limit) || 100, 500);

  try {
    const result = await pool.query(
      `SELECT
        m.id, m.text, m.created_at, m.zone_id,
        u.public_name AS author_name,
        u.avatar_url  AS author_avatar,
        u.id AS user_id
       FROM chat_messages m
       LEFT JOIN users u ON m.user_id = u.id
       WHERE m.zone_id = $1
         AND m.created_at > NOW() - INTERVAL '24 hours'
       ORDER BY m.created_at ASC
       LIMIT $2`,
      [targetZone, safeLimit]
    );

    res.json({ messages: result.rows, zone: targetZone });
  } catch (err) {
    console.error('Chat history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
