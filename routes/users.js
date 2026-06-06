const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { spendCoins, getCoins, COSTS } = require('../services/economy');

// ── POST /user/register (legacy device_id flow) ───────────────────────────────
router.post('/register', async (req, res) => {
  const { device_id, public_name, geohash, is_under_16 } = req.body;
  if (!device_id || !public_name || !geohash)
    return res.status(400).json({ error: 'Missing required fields' });
  if (public_name.length < 2 || public_name.length > 50)
    return res.status(400).json({ error: 'public_name must be 2–50 chars' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE device_id = $1', [device_id]);
    if (existing.rows.length > 0) {
      const user = await pool.query('SELECT * FROM users WHERE device_id = $1', [device_id]);
      return res.json({ user: sanitize(user.rows[0]), created: false });
    }
    const result = await pool.query(
      `INSERT INTO users (public_name, current_geohash, device_id, is_under_16)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [public_name.trim(), geohash, device_id, is_under_16 || false]
    );
    const u = result.rows[0];
    await Promise.all([
      pool.query('INSERT INTO user_coins (user_id,coins) VALUES ($1,0) ON CONFLICT DO NOTHING', [u.id]),
      pool.query('INSERT INTO user_streaks (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.id]),
    ]);
    res.status(201).json({ user: sanitize(u), created: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Device already registered' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /user/me ──────────────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const [coinsRow, streakRow] = await Promise.all([
      pool.query('SELECT coins FROM user_coins WHERE user_id=$1', [req.user.id]),
      pool.query('SELECT * FROM user_streaks WHERE user_id=$1', [req.user.id]),
    ]);
    const user = { ...req.user };
    delete user.device_id;
    res.json({
      user: {
        ...user,
        coins:  coinsRow.rows[0]?.coins ?? 0,
        streak: streakRow.rows[0] ?? { current_streak: 0, longest_streak: 0 },
      }
    });
  } catch (err) {
    console.error('GET /me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /user/location ────────────────────────────────────────────────────────
router.put('/location', auth, async (req, res) => {
  const { geohash } = req.body;
  if (!geohash) return res.status(400).json({ error: 'geohash required' });
  try {
    await pool.query(
      'UPDATE users SET current_geohash=$1, last_active=NOW() WHERE id=$2',
      [geohash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /user/name ────────────────────────────────────────────────────────────
router.put('/name', auth, async (req, res) => {
  const { new_name } = req.body;
  if (!new_name || new_name.trim().length < 2)
    return res.status(400).json({ error: 'Nombre demasiado corto' });

  const user = req.user;
  if (user.name_changed_at) {
    const daysSince = (Date.now() - new Date(user.name_changed_at).getTime()) / (1000*60*60*24);
    if (daysSince < 7)
      return res.status(429).json({ error: `Puedes cambiar el nombre en ${Math.ceil(7-daysSince)} días` });
  }

  const currentCoins = await getCoins(user.id);
  if (currentCoins < COSTS.buy_name)
    return res.status(402).json({ error: `Necesitas ${COSTS.buy_name} monedas. Tienes ${currentCoins}.` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await spendCoins(user.id, 'buy_name', client);
    const history = user.name_history || [];
    history.push({ name: user.public_name, changed_at: new Date().toISOString() });
    await client.query(
      'UPDATE users SET public_name=$1, name_history=$2, name_changed_at=NOW() WHERE id=$3',
      [new_name.trim(), JSON.stringify(history.slice(-10)), user.id]
    );
    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM users WHERE id=$1', [user.id]);
    res.json({ user: sanitize(updated.rows[0]), ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message === 'INSUFFICIENT_COINS')
      return res.status(402).json({ error: 'Not enough coins' });
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

// ── POST /user/avatar ─────────────────────────────────────────────────────────
router.post('/avatar', auth, async (req, res) => {
  const { image_base64 } = req.body;
  if (!image_base64) return res.status(400).json({ error: 'image_base64 requerido' });

  try {
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    const result = await cloudinary.uploader.upload(image_base64, {
      folder:         'zas_avatars',
      public_id:      `avatar_${req.user.id}`,
      overwrite:      true,
      transformation: [{ width: 200, height: 200, crop: 'fill', gravity: 'face' }],
    });

    await pool.query(
      'UPDATE users SET avatar_url=$1 WHERE id=$2',
      [result.secure_url, req.user.id]
    );

    res.json({ avatar_url: result.secure_url, ok: true });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Error al subir la imagen: ' + err.message });
  }
});

// ── DELETE /user ──────────────────────────────────────────────────────────────
router.delete('/', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

function sanitize(user) {
  const { device_id, password_hash, verify_token, reset_token, ...safe } = user;
  return safe;
}

module.exports = router;


// ── POST /user/push-token → registrar token de notificaciones ────────────────
router.post('/push-token', auth, async (req, res) => {
  const { token, platform = 'android' } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET token=$2, platform=$3, updated_at=NOW()`,
      [req.user.id, token, platform]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /user/:id/profile → perfil público de un usuario ─────────────────────
router.get('/:id/profile', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.public_name, u.karma, u.avatar_url, u.created_at,
              COALESCE(uc.coins, 0) AS coins,
              COALESCE(us.current_streak, 0) AS current_streak,
              COALESCE(us.longest_streak, 0) AS longest_streak,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id)::int AS followers_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id  = u.id)::int AS following_count,
              EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND following_id=u.id) AS is_following
       FROM users u
       LEFT JOIN user_coins   uc ON uc.user_id = u.id
       LEFT JOIN user_streaks us ON us.user_id = u.id
       WHERE u.id = $1`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /user/active-count ────────────────────────────────────────────────────
// Devuelve cuántos usuarios han estado activos en los últimos 15 minutos en la zona
router.get('/active-count', auth, async (req, res) => {
  const { geohash } = req.query;
  if (!geohash) return res.status(400).json({ error: 'geohash required' });
  try {
    const zonePrefix = geohash.slice(0, 5);
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM users
       WHERE current_geohash LIKE $1
         AND last_active > NOW() - INTERVAL '15 minutes'`,
      [`${zonePrefix}%`]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
