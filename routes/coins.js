const express = require('express');
const router = express.Router();
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

module.exports = router;
