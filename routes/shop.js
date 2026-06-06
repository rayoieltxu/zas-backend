/**
 * routes/shop.js — Tienda de zona
 * GET  /shop            — listar todos los items con estado del usuario
 * POST /shop/buy/:id    — comprar item (descuenta monedas)
 * POST /shop/equip/:id  — equipar/desequipar item
 * GET  /shop/inventory  — mis items comprados
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');

// GET /shop
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         si.id, si.name, si.type, si.icon, si.description, si.price, si.rarity,
         ui.bought_at IS NOT NULL AS owned,
         COALESCE(ui.equipped, false) AS equipped
       FROM shop_items si
       LEFT JOIN user_items ui ON ui.item_id=si.id AND ui.user_id=$1
       ORDER BY si.rarity DESC, si.price ASC`,
      [req.user.id]
    );
    const { rows: coinsRow } = await pool.query(
      'SELECT coins FROM user_coins WHERE user_id=$1', [req.user.id]
    );
    res.json({ items: result.rows, coins: coinsRow[0]?.coins ?? 0 });
  } catch (err) {
    console.error('Shop GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /shop/inventory
router.get('/inventory', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT si.id, si.name, si.type, si.icon, si.description, si.rarity,
              ui.bought_at, ui.equipped
       FROM user_items ui
       JOIN shop_items si ON si.id=ui.item_id
       WHERE ui.user_id=$1
       ORDER BY ui.bought_at DESC`,
      [req.user.id]
    );
    res.json({ items: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /shop/buy/:id
router.post('/buy/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que el item existe
    const itemRes = await client.query('SELECT * FROM shop_items WHERE id=$1', [req.params.id]);
    if (!itemRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item no encontrado' });
    }
    const item = itemRes.rows[0];

    // Verificar que no lo tiene ya
    const owned = await client.query(
      'SELECT 1 FROM user_items WHERE user_id=$1 AND item_id=$2', [req.user.id, item.id]
    );
    if (owned.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ya tienes este item' });
    }

    // Verificar fondos
    const coinsRes = await client.query(
      'SELECT coins FROM user_coins WHERE user_id=$1 FOR UPDATE', [req.user.id]
    );
    const coins = coinsRes.rows[0]?.coins ?? 0;
    if (coins < item.price) {
      await client.query('ROLLBACK');
      return res.status(402).json({ error: `Monedas insuficientes (tienes ${coins}, necesitas ${item.price})` });
    }

    // Descontar monedas
    await client.query(
      'UPDATE user_coins SET coins=coins-$1, updated_at=NOW() WHERE user_id=$2',
      [item.price, req.user.id]
    );
    await client.query(
      `INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,$2,'shop_purchase')`,
      [req.user.id, -item.price]
    );

    // Añadir item al inventario
    await client.query(
      'INSERT INTO user_items (user_id, item_id) VALUES ($1,$2)',
      [req.user.id, item.id]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      item,
      coins_left: coins - item.price,
      message: `¡Compraste "${item.name}"! 🎉`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Shop buy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

// POST /shop/equip/:id — toggle equipar
router.post('/equip/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT equipped FROM user_items WHERE user_id=$1 AND item_id=$2',
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No tienes ese item' });

    const itemInfo = await pool.query('SELECT type FROM shop_items WHERE id=$1', [req.params.id]);
    const itemType = itemInfo.rows[0]?.type;
    const newEquipped = !rows[0].equipped;

    // Solo puede haber 1 equipado por tipo
    if (newEquipped && itemType) {
      await pool.query(
        `UPDATE user_items ui
         SET equipped=false
         WHERE ui.user_id=$1
           AND ui.item_id IN (SELECT id FROM shop_items WHERE type=$2)`,
        [req.user.id, itemType]
      );
    }

    await pool.query(
      'UPDATE user_items SET equipped=$1 WHERE user_id=$2 AND item_id=$3',
      [newEquipped, req.user.id, req.params.id]
    );
    res.json({ ok: true, equipped: newEquipped });
  } catch (err) {
    console.error('Shop equip error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
