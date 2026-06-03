const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { spendCoins, getCoins, COSTS } = require('../services/economy');

// POST /user/register
router.post('/register', async (req, res) => {
  const { device_id, public_name, geohash, is_under_16 } = req.body;
  if (!device_id || !public_name || !geohash)
    return res.status(400).json({ error: 'Missing required fields: device_id, public_name, geohash' });
  if (public_name.length < 2 || public_name.length > 50)
    return res.status(400).json({ error: 'public_name must be 2–50 chars' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE device_id = $1', [device_id]);
    if (existing.rows.length > 0) {
      const user = await pool.query('SELECT * FROM users WHERE device_id = $1', [device_id]);
      return res.json({ user: sanitizeUser(user.rows[0]), created: false });
    }
    const result = await pool.query(
      `INSERT INTO users (public_name, current_geohash, device_id, is_under_16)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [public_name.trim(), geohash, device_id, is_under_16 || false]
    );
    const newUser = result.rows[0];

    // Inicializar monedas y racha para el nuevo usuario
    await pool.query(
      `INSERT INTO user_coins (user_id, coins) VALUES ($1, 0) ON CONFLICT DO NOTHING`,
      [newUser.id]
    );
    await pool.query(
      `INSERT INTO user_streaks (user_id, current_streak, longest_streak) VALUES ($1, 0, 0) ON CONFLICT DO NOTHING`,
      [newUser.id]
    );

    res.status(201).json({ user: sanitizeUser(newUser), created: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Device already registered' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /user/me — incluye coins y streak
router.get('/me', auth, async (req, res) => {
  try {
    const [coinsRow, streakRow] = await Promise.all([
      pool.query('SELECT coins FROM user_coins WHERE user_id = $1', [req.user.id]),
      pool.query('SELECT * FROM user_streaks WHERE user_id = $1', [req.user.id]),
    ]);
    const coins = coinsRow.rows[0]?.coins ?? 0;
    const streak = streakRow.rows[0] ?? { current_streak: 0, longest_streak: 0 };
    res.json({ user: { ...sanitizeUser(req.user), coins, streak } });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /user/location
router.put('/location', auth, async (req, res) => {
  const { geohash } = req.body;
  if (!geohash) return res.status(400).json({ error: 'Missing geohash' });
  try {
    await pool.query(
      'UPDATE users SET current_geohash = $1, last_active = NOW() WHERE id = $2',
      [geohash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /user/name — requiere cooldown de 7 días Y 50 monedas (Fase 1)
router.put('/name', auth, async (req, res) => {
  const { new_name } = req.body;
  if (!new_name || new_name.length < 2 || new_name.length > 50)
    return res.status(400).json({ error: 'new_name must be 2–50 chars' });

  const user = req.user;

  // Cooldown de 7 días
  if (user.name_changed_at) {
    const daysSince = (Date.now() - new Date(user.name_changed_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) {
      const daysLeft = Math.ceil(7 - daysSince);
      return res.status(429).json({
        error: `Cooldown activo. Disponible en ${daysLeft} día(s).`,
        days_left: daysLeft,
      });
    }
  }

  // Comprobar saldo (coste: 50 monedas)
  const currentCoins = await getCoins(user.id);
  if (currentCoins < COSTS.buy_name) {
    return res.status(402).json({
      error: `Necesitas ${COSTS.buy_name} monedas para cambiar el nombre. Tienes ${currentCoins}.`,
      coins_needed: COSTS.buy_name,
      coins_have: currentCoins,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Gastar monedas
    await spendCoins(user.id, 'buy_name', client);

    // Guardar historial y actualizar nombre
    const history = user.name_history || [];
    history.push({ name: user.public_name, changed_at: new Date().toISOString() });

    await client.query(
      `UPDATE users
       SET public_name = $1, name_history = $2, name_changed_at = NOW()
       WHERE id = $3`,
      [new_name.trim(), JSON.stringify(history.slice(-10)), user.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, new_name: new_name.trim(), coins_spent: COSTS.buy_name });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message === 'INSUFFICIENT_COINS') {
      return res.status(402).json({ error: 'Not enough coins' });
    }
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// DELETE /user
router.delete('/', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

function sanitizeUser(user) {
  const { device_id, ...safe } = user;
  return safe;
}

// Instalar: npm install cloudinary
const cloudinary = require('cloudinary').v2;
 
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
 
// POST /user/avatar
router.post('/avatar', auth, async (req, res) => {
  const { image_base64 } = req.body;
  if (!image_base64) return res.status(400).json({ error: 'image_base64 requerido' });
 
  try {
    const result = await cloudinary.uploader.upload(image_base64, {
      folder:         'zas_avatars',
      public_id:      `avatar_${req.user.id}`,
      overwrite:      true,
      transformation: [{ width: 200, height: 200, crop: 'fill', gravity: 'face' }],
    });
 
    const avatarUrl = result.secure_url;
 
    await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2',
      [avatarUrl, req.user.id]
    );
 
    res.json({ avatar_url: avatarUrl });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Error al subir la imagen' });
  }
});

module.exports = router;
