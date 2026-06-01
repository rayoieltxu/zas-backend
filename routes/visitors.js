const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { spendCoins } = require('../services/economy');

const VISITOR_DURATION_HOURS = 24;

// ─── GET /visitor/status → estado de visita actual ───────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM visitors WHERE user_id = $1 AND expires_at > NOW()',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({ is_visitor: false });
    }

    const v = result.rows[0];
    const hoursLeft = Math.ceil((new Date(v.expires_at) - Date.now()) / 3600000);

    res.json({
      is_visitor:       true,
      original_zone:    v.original_zone,
      current_zone:     v.current_zone,
      expires_at:       v.expires_at,
      hours_left:       hoursLeft,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /visitor/travel → viajar a otra zona (50 monedas) ─────────────────
router.post('/travel', auth, async (req, res) => {
  const { destination_zone } = req.body;

  if (!destination_zone) {
    return res.status(400).json({ error: 'destination_zone required' });
  }

  // No puedes viajar a tu propia zona
  if (destination_zone.slice(0, 5) === req.user.current_geohash.slice(0, 5)) {
    return res.status(400).json({ error: 'Ya estás en esa zona' });
  }

  // No puedes viajar si ya eres visitante en otra zona
  if (req.user.is_visitor) {
    return res.status(409).json({
      error: 'Ya estás de visita en otra zona. Vuelve primero.',
      current_zone:  req.user.visitor_zone,
      expires_at:    req.user.visitor_expires,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Gastar 50 monedas
    await spendCoins(req.user.id, 'travel_zone', client);

    const expiresAt = new Date(Date.now() + VISITOR_DURATION_HOURS * 3600000);

    await client.query(
      `INSERT INTO visitors (user_id, original_zone, current_zone, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET current_zone = $3, expires_at = $4`,
      [req.user.id, req.user.current_geohash, destination_zone, expiresAt]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      is_visitor:    true,
      original_zone: req.user.current_geohash,
      current_zone:  destination_zone,
      expires_at:    expiresAt,
      hours:         VISITOR_DURATION_HOURS,
      restrictions:  ['no_vote', 'no_treasure', 'no_karma'],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message === 'INSUFFICIENT_COINS') {
      return res.status(402).json({ error: 'Necesitas 50 monedas para viajar' });
    }
    console.error('POST /visitor/travel error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── DELETE /visitor/return → volver a zona original ─────────────────────────
router.delete('/return', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM visitors WHERE user_id = $1 RETURNING original_zone',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'No estás de visita en ninguna zona' });
    }

    res.json({
      ok: true,
      returned_to: result.rows[0].original_zone,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
