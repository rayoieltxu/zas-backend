const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { spendCoins, getCoins, COSTS } = require('../services/economy');

// ── POST /user/daily-bonus ────────────────────────────────────────────────────
router.post('/daily-bonus', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const check = await pool.query(
      `SELECT 1 FROM coin_daily_limits WHERE user_id=$1 AND action='daily_bonus' AND day=$2`,
      [req.user.id, today]
    );
    if (check.rows.length > 0) {
      return res.json({ ok: false, already_claimed: true, message: 'Ya recogiste tu bonus hoy' });
    }
    const streakRes = await pool.query(
      'SELECT current_streak FROM user_streaks WHERE user_id=$1', [req.user.id]
    );
    const streak = streakRes.rows[0]?.current_streak || 0;
    const bonus  = Math.min(5 + streak * 2, 50);
    await pool.query(
      `INSERT INTO coin_daily_limits (user_id, action, day, count) VALUES ($1,'daily_bonus',$2,1)
       ON CONFLICT (user_id, action, day) DO UPDATE SET count=1`,
      [req.user.id, today]
    );
    await pool.query(
      `INSERT INTO user_coins (user_id, coins) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET coins=user_coins.coins+$2, updated_at=NOW()`,
      [req.user.id, bonus]
    );
    await pool.query(
      `INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,$2,'daily_bonus')`,
      [req.user.id, bonus]
    );
    res.json({ ok: true, bonus, streak, message: `+${bonus} 🪙 Bonus diario` });
  } catch (err) {
    console.error('Daily bonus error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /user/register ───────────────────────────────────────────────────────
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
    // Generar código de referido único
    let referralCode = null;
    for (let attempts = 0; attempts < 5; attempts++) {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      const exists = await pool.query('SELECT 1 FROM users WHERE referral_code=$1', [code]);
      if (exists.rows.length === 0) { referralCode = code; break; }
    }
    const result = await pool.query(
      `INSERT INTO users (public_name, current_geohash, device_id, is_under_16, referral_code)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [public_name.trim(), geohash, device_id, is_under_16 || false, referralCode]
    );
    const u = result.rows[0];
    await Promise.all([
      pool.query('INSERT INTO user_coins (user_id,coins) VALUES ($1,0) ON CONFLICT DO NOTHING', [u.id]),
      pool.query('INSERT INTO user_streaks (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.id]),
    ]);

    // Aplicar código de referido si se proporcionó
    const { referral_code: appliedCode } = req.body;
    if (appliedCode) {
      try {
        const referrer = await pool.query(
          'SELECT id FROM users WHERE referral_code = $1 AND id != $2',
          [appliedCode.toUpperCase(), u.id]
        );
        if (referrer.rows.length > 0) {
          const referrerId = referrer.rows[0].id;
          await pool.query(
            `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [referrerId, u.id]
          );
          // +50 monedas para ambos
          await Promise.all([
            pool.query(`UPDATE user_coins SET coins=coins+50 WHERE user_id=$1`, [u.id]),
            pool.query(`UPDATE user_coins SET coins=coins+50 WHERE user_id=$1`, [referrerId]),
            pool.query(`INSERT INTO coin_transactions (user_id,delta,reason) VALUES ($1,50,'referral_bonus')`, [u.id]),
            pool.query(`INSERT INTO coin_transactions (user_id,delta,reason) VALUES ($1,50,'referral_reward')`, [referrerId]),
          ]);
          await pool.query(`UPDATE referrals SET rewarded=true WHERE referrer_id=$1 AND referred_id=$2`, [referrerId, u.id]);
        }
      } catch (refErr) {
        console.error('Referral apply error:', refErr);
      }
    }

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
    const [coinsRow, streakRow, equippedRow] = await Promise.all([
      pool.query('SELECT coins FROM user_coins WHERE user_id=$1', [req.user.id]),
      pool.query('SELECT * FROM user_streaks WHERE user_id=$1', [req.user.id]),
      pool.query(
        `SELECT si.id, si.name, si.type, si.icon, si.rarity, si.description
         FROM user_items ui
         JOIN shop_items si ON si.id=ui.item_id
         WHERE ui.user_id=$1 AND ui.equipped=true`,
        [req.user.id]
      ),
    ]);
    const user = { ...req.user };
    delete user.device_id;
    // Agrupar items equipados por tipo para fácil acceso
    const equipped = {};
    for (const item of equippedRow.rows) equipped[item.type] = item;
    res.json({
      user: {
        ...user,
        coins:   coinsRow.rows[0]?.coins ?? 0,
        streak:  streakRow.rows[0] ?? { current_streak: 0, longest_streak: 0 },
        equipped,           // { frame: {...}, badge: {...}, title: {...}, emoji_pack: {...} }
        equipped_list: equippedRow.rows,
      }
    });
  } catch (err) {
    console.error('GET /me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /user/active-count ────────────────────────────────────────────────────
router.get('/active-count', auth, async (req, res) => {
  const { geohash } = req.query;
  if (!geohash) return res.status(400).json({ error: 'geohash required' });
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM users
       WHERE current_geohash LIKE $1 AND last_active > NOW() - INTERVAL '15 minutes'`,
      [`${geohash.slice(0, 5)}%`]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
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
    await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [result.secure_url, req.user.id]);
    res.json({ avatar_url: result.secure_url, ok: true });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Error al subir la imagen: ' + err.message });
  }
});

// ── POST /user/push-token ─────────────────────────────────────────────────────
router.post('/push-token', auth, async (req, res) => {
  const { token, platform = 'android' } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id) DO UPDATE SET token=$2, platform=$3, updated_at=NOW()`,
      [req.user.id, token, platform]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /user/:id/profile ─────────────────────────────────────────────────────
router.get('/:id/profile', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.public_name, u.karma, u.avatar_url, u.created_at,
              COALESCE(uc.coins, 0) AS coins,
              COALESCE(us.current_streak, 0) AS current_streak,
              COALESCE(us.longest_streak, 0) AS longest_streak,
              (SELECT COUNT(*) FROM follows WHERE following_id=u.id)::int AS followers_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id=u.id)::int  AS following_count,
              EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND following_id=u.id) AS is_following
       FROM users u
       LEFT JOIN user_coins   uc ON uc.user_id=u.id
       LEFT JOIN user_streaks us ON us.user_id=u.id
       WHERE u.id=$1`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    const badges = await pool.query(
      `SELECT DISTINCT c.badge_name FROM user_challenges uc
       JOIN challenges c ON c.id=uc.challenge_id
       WHERE uc.user_id=$1 AND uc.claimed=true AND c.badge_name IS NOT NULL`,
      [req.params.id]
    );
    res.json({ user: { ...result.rows[0], badges: badges.rows.map(b => b.badge_name) } });
  } catch (err) {
    console.error('GET /user/:id/profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /user/referral ────────────────────────────────────────────────────────
router.get('/referral', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT referral_code,
              (SELECT COUNT(*) FROM referrals WHERE referrer_id=$1)::int AS total_referred,
              (SELECT COUNT(*) FROM referrals WHERE referrer_id=$1 AND rewarded=true)::int AS rewarded_count
       FROM users WHERE id=$1`,
      [req.user.id]
    );
    const row = result.rows[0];
    res.json({
      code:            row.referral_code,
      total_referred:  row.total_referred,
      rewarded_count:  row.rewarded_count,
      coins_earned:    row.rewarded_count * 50,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
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
