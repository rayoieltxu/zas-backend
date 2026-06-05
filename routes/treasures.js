const express  = require('express');
const router   = express.Router();
const pool     = require('../db/pool');
const auth     = require('../middleware/auth');
const { spendCoins, TREASURE_TIERS, updateChallengeProgress } = require('../services/economy');

// ─── GET /treasures?zone=geohash ─────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const zone   = req.query.zone || req.user.current_geohash;
  const prefix = zone.slice(0, 5);

  try {
    const result = await pool.query(
      `SELECT
         t.id, t.geohash, t.hint, t.tier,
         t.reward_coins, t.reward_karma,
         t.created_at, t.expires_at,
         u.public_name AS created_by_name,
         t.created_by
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

// ─── POST /treasures → esconder tesoro ───────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const { hint, geohash, tier = 'chispa' } = req.body;

  if (!hint || hint.trim().length < 5) {
    return res.status(400).json({ error: 'La pista debe tener al menos 5 caracteres' });
  }
  if (!geohash) {
    return res.status(400).json({ error: 'Geohash requerido' });
  }
  if (!TREASURE_TIERS[tier]) {
    return res.status(400).json({ error: 'Tier inválido. Usa: chispa, reliquia o leyenda' });
  }
  // 4 chars ≈ 25 km — permite esconder en zonas vecinas pero no justo encima
  if (geohash.slice(0, 4) === req.user.current_geohash.slice(0, 4)) {
    return res.status(400).json({ error: 'El tesoro debe estar en una zona más alejada de donde estás tú' });
  }

  const tierCfg = TREASURE_TIERS[tier];
  const client  = await pool.connect();
  try {
    await client.query('BEGIN');

    // Gastar monedas según el tier
    const coinsRow = await client.query(
      'SELECT coins FROM user_coins WHERE user_id=$1 FOR UPDATE',
      [req.user.id]
    );
    const current = coinsRow.rows[0]?.coins ?? 0;
    if (current < tierCfg.cost) {
      await client.query('ROLLBACK');
      return res.status(402).json({ error: `Necesitas ${tierCfg.cost} monedas para esconder una ${tierCfg.label}` });
    }
    await client.query(
      'UPDATE user_coins SET coins=coins-$1, updated_at=NOW() WHERE user_id=$2',
      [tierCfg.cost, req.user.id]
    );
    await client.query(
      'INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,$2,$3)',
      [req.user.id, -tierCfg.cost, `create_treasure_${tier}`]
    );

    const result = await client.query(
      `INSERT INTO treasures (geohash, hint, tier, reward_coins, reward_karma, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [geohash, hint.trim(), tier, tierCfg.reward_coins, tierCfg.reward_karma, req.user.id]
    );

    await client.query('COMMIT');

    updateChallengeProgress(req.user.id, 'treasures_hidden').catch(() => {});

    res.status(201).json({ treasure: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /treasures error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── POST /treasures/:id/claim → reclamar tesoro ─────────────────────────────
router.post('/:id/claim', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    // Verificar proximidad (7 chars ≈ 150m)
    if (req.user.current_geohash.slice(0, 7) !== treasure.geohash.slice(0, 7)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No estás en la ubicación del tesoro' });
    }

    await client.query(
      'UPDATE treasures SET found_by=$1, found_at=NOW() WHERE id=$2',
      [req.user.id, treasure.id]
    );
    await client.query(
      `INSERT INTO user_coins (user_id, coins) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET coins=user_coins.coins+$2, updated_at=NOW()`,
      [req.user.id, treasure.reward_coins]
    );
    await client.query(
      'INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,$2,$3)',
      [req.user.id, treasure.reward_coins, 'treasure_found']
    );
    await client.query(
      'UPDATE users SET karma=karma+$1 WHERE id=$2',
      [treasure.reward_karma, req.user.id]
    );

    await client.query('COMMIT');

    updateChallengeProgress(req.user.id, 'treasures_found').catch(() => {});

    res.json({
      ok: true,
      reward_coins: treasure.reward_coins,
      reward_karma: treasure.reward_karma,
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
