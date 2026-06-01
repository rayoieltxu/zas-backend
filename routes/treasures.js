const express  = require('express');
const router   = express.Router();
const pool     = require('../db/pool');
const auth     = require('../middleware/auth');
const { spendCoins } = require('../services/economy');

// ─── GET /treasures?zone=geohash ─────────────────────────────────────────────
// Lista tesoros activos (no encontrados) cerca de la zona del usuario.
router.get('/', auth, async (req, res) => {
  const zone      = req.query.zone || req.user.current_geohash;
  const prefix    = zone.slice(0, 5); // ~5 km

  try {
    const result = await pool.query(
      `SELECT
         t.id, t.geohash, t.hint, t.reward_coins, t.reward_karma,
         t.created_at, t.expires_at,
         u.public_name AS created_by_name,
         (t.created_by = $1) AS is_mine
       FROM treasures t
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.found_by IS NULL
         AND t.expires_at > NOW()
         AND t.geohash LIKE $2
       ORDER BY t.created_at DESC
       LIMIT 50`,
      [req.user.id, `${prefix}%`]
    );
    res.json({ treasures: result.rows });
  } catch (err) {
    console.error('GET /treasures error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /treasures → esconder tesoro (cuesta 50 monedas) ───────────────────
router.post('/', auth, async (req, res) => {
  const { hint, geohash } = req.body;

  if (!hint || hint.trim().length < 5) {
    return res.status(400).json({ error: 'hint must be at least 5 characters' });
  }
  if (!geohash) {
    return res.status(400).json({ error: 'geohash is required' });
  }
  // El tesoro debe estar en una zona diferente a donde está el usuario
  if (geohash.slice(0, 5) === req.user.current_geohash.slice(0, 5)) {
    return res.status(400).json({
      error: 'El tesoro debe estar en una zona diferente a la tuya',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Gastar monedas
    await spendCoins(req.user.id, 'create_treasure', client);

    const result = await client.query(
      `INSERT INTO treasures (geohash, hint, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [geohash, hint.trim(), req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ treasure: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message === 'INSUFFICIENT_COINS') {
      return res.status(402).json({ error: 'Necesitas 50 monedas para esconder un tesoro' });
    }
    console.error('POST /treasures error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── POST /treasures/:id/claim → reclamar tesoro ─────────────────────────────
// El usuario debe estar físicamente en el geohash del tesoro.
router.post('/:id/claim', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener tesoro
    const tResult = await client.query(
      'SELECT * FROM treasures WHERE id = $1',
      [req.params.id]
    );
    if (tResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Treasure not found' });
    }
    const treasure = tResult.rows[0];

    if (treasure.found_by) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este tesoro ya fue encontrado' });
    }
    if (treasure.expires_at < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Este tesoro ha expirado' });
    }
    if (treasure.created_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No puedes reclamar tu propio tesoro' });
    }

    // Verificar que el usuario está en la zona del tesoro (prefijo de 7 chars ≈ 150m)
    const userGeo    = req.user.current_geohash;
    const treasureGeo = treasure.geohash;
    if (userGeo.slice(0, 7) !== treasureGeo.slice(0, 7)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'No estás en la ubicación del tesoro',
        required_geohash: treasureGeo.slice(0, 7),
        your_geohash:     userGeo.slice(0, 7),
      });
    }

    // Marcar como encontrado
    await client.query(
      `UPDATE treasures SET found_by = $1, found_at = NOW() WHERE id = $2`,
      [req.user.id, treasure.id]
    );

    // Dar recompensa de monedas
    await client.query(
      `INSERT INTO user_coins (user_id, coins) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET coins = user_coins.coins + $2, updated_at = NOW()`,
      [req.user.id, treasure.reward_coins]
    );
    await client.query(
      `INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1, $2, 'treasure_found')`,
      [req.user.id, treasure.reward_coins]
    );

    // Dar karma al encontrador
    await client.query(
      'UPDATE users SET karma = karma + $1 WHERE id = $2',
      [treasure.reward_karma, req.user.id]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      reward_coins: treasure.reward_coins,
      reward_karma: treasure.reward_karma,
      message: '¡Tesoro encontrado! 🎉',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /treasures/:id/claim error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
