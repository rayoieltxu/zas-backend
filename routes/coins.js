const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const {
  getCoins,
  spendCoins,
  getTransactionHistory,
  COSTS,
} = require('../services/economy');

// GET /coins → saldo actual + últimas transacciones
router.get('/', auth, async (req, res) => {
  try {
    const [coins, history] = await Promise.all([
      getCoins(req.user.id),
      getTransactionHistory(req.user.id, 20),
    ]);
    res.json({ coins, history, costs: COSTS });
  } catch (err) {
    console.error('GET /coins error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /coins/spend → gastar monedas en una acción
// body: { action: 'buy_name' | 'highlight_post' | 'create_channel' | ... }
router.post('/spend', auth, async (req, res) => {
  const { action } = req.body;
  if (!action || !COSTS[action]) {
    return res.status(400).json({
      error: 'Invalid action',
      valid_actions: Object.keys(COSTS),
    });
  }

  try {
    const remaining = await spendCoins(req.user.id, action);
    res.json({ ok: true, action, coins_remaining: remaining });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_COINS') {
      return res.status(402).json({
        error: 'Not enough coins',
        cost: COSTS[action],
      });
    }
    console.error('POST /coins/spend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /coins/daily-bonus → bonus diario de login
router.post('/daily-bonus', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    // Comprobar si ya reclamó hoy
    const check = await client.query(
      `SELECT 1 FROM coin_daily_limits
       WHERE user_id=$1 AND action='daily_bonus' AND day=$2`,
      [req.user.id, today]
    );
    if (check.rows.length > 0) {
      return res.status(400).json({ error: 'Ya reclamaste el bonus hoy', already_claimed: true });
    }

    // Calcular bonus según racha
    const streakRes = await client.query(
      'SELECT current_streak FROM user_streaks WHERE user_id=$1',
      [req.user.id]
    );
    const streak = streakRes.rows[0]?.current_streak || 0;
    const bonus = streak >= 30 ? 50 : streak >= 7 ? 30 : streak >= 3 ? 20 : 10;

    await client.query(
      `INSERT INTO coin_daily_limits (user_id, action, day, count) VALUES ($1,'daily_bonus',$2,1)
       ON CONFLICT (user_id, action, day) DO UPDATE SET count=1`,
      [req.user.id, today]
    );
    await client.query(
      `INSERT INTO user_coins (user_id, coins) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET coins=user_coins.coins+$2, updated_at=NOW()`,
      [req.user.id, bonus]
    );
    await client.query(
      'INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,$2,$3)',
      [req.user.id, bonus, 'daily_bonus']
    );

    res.json({ ok: true, bonus, streak });
  } catch (err) {
    console.error('Daily bonus error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
