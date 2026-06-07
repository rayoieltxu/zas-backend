/**
 * routes/moments.js — El Momento ZAS
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { sendPush } = require('../services/push');

const WINDOW_MINUTES = 5;
const FEED_HOURS     = 24;
const MOMENT_COINS   = 30;  // monedas por subir a tiempo
const MOMENT_KARMA   = 10;  // karma extra

// ── GET /moments/status ───────────────────────────────────────────────────────
// Devuelve si hay ventana activa ahora y si el usuario ya subió su foto hoy
router.get('/status', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const windowRes = await pool.query(
      `SELECT * FROM moment_windows WHERE date=$1`,
      [today]
    );
    const win = windowRes.rows[0];
    if (!win) return res.json({ active: false, submitted: false });

    const now = new Date();
    const active    = now >= new Date(win.started_at) && now <= new Date(win.expires_at);
    const submitted = !!(await pool.query(
      `SELECT 1 FROM zas_moments WHERE user_id=$1 AND window_id=$2`,
      [req.user.id, win.id]
    )).rows.length;

    res.json({
      active,
      submitted,
      window_id:  win.id,
      started_at: win.started_at,
      expires_at: win.expires_at,
      seconds_left: active ? Math.max(0, Math.floor((new Date(win.expires_at) - now) / 1000)) : 0,
    });
  } catch (err) {
    console.error('Moments status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /moments ─────────────────────────────────────────────────────────────
// Subir la foto del momento
router.post('/', auth, async (req, res) => {
  const { image_url, caption, window_id } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url requerido' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const winRes = await pool.query(
      `SELECT * FROM moment_windows WHERE id=$1 AND date=$2`,
      [window_id, today]
    );
    const win = winRes.rows[0];
    if (!win) return res.status(404).json({ error: 'Ventana no encontrada' });

    const now = new Date();
    if (now > new Date(win.expires_at))
      return res.status(410).json({ error: 'La ventana ha expirado', code: 'WINDOW_EXPIRED' });

    const zone     = req.user.current_geohash;
    const feedUntil = new Date(Date.now() + FEED_HOURS * 3600 * 1000);

    const result = await pool.query(
      `INSERT INTO zas_moments (user_id, window_id, image_url, caption, zone, feed_until)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, window_id) DO NOTHING
       RETURNING *`,
      [req.user.id, win.id, image_url, caption?.trim() || null, zone, feedUntil]
    );
    if (!result.rows.length)
      return res.status(409).json({ error: 'Ya subiste tu momento hoy' });

    const moment = result.rows[0];

    // Recompensas: monedas + karma
    await Promise.all([
      pool.query(`INSERT INTO user_coins (user_id,coins) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET coins=user_coins.coins+$2`, [req.user.id, MOMENT_COINS]),
      pool.query(`INSERT INTO coin_transactions (user_id,delta,reason) VALUES ($1,$2,'momento_zas')`, [req.user.id, MOMENT_COINS]),
      pool.query(`UPDATE users SET karma=karma+$1 WHERE id=$2`, [MOMENT_KARMA, req.user.id]),
      // Actualizar racha de momentos
      pool.query(`
        UPDATE user_streaks
        SET momento_streak = CASE WHEN last_momento = CURRENT_DATE - 1 THEN momento_streak+1 ELSE 1 END,
            last_momento   = CURRENT_DATE
        WHERE user_id=$1
      `, [req.user.id]),
    ]);

    // Emitir al feed de la zona en tiempo real
    const io = req.app.get('io');
    if (io) {
      const zoneRoom = `zone:${zone.slice(0, 5)}`;
      io.to(zoneRoom).emit('new_moment', {
        moment: { ...moment, author_name: req.user.public_name, author_avatar: req.user.avatar_url }
      });
    }

    res.status(201).json({ moment, coins_earned: MOMENT_COINS, karma_earned: MOMENT_KARMA });
  } catch (err) {
    console.error('Moments upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /moments/feed ─────────────────────────────────────────────────────────
// Momentos activos en el feed de la zona (últimas 24h)
router.get('/feed', auth, async (req, res) => {
  const zone = req.query.zone || req.user.current_geohash;
  try {
    const result = await pool.query(
      `SELECT zm.id, zm.image_url, zm.caption, zm.created_at, zm.feed_until,
              u.public_name AS author_name, u.avatar_url AS author_avatar,
              us.momento_streak,
              (zm.user_id = $1) AS is_mine
       FROM zas_moments zm
       JOIN users u ON u.id = zm.user_id
       LEFT JOIN user_streaks us ON us.user_id = zm.user_id
       WHERE zm.zone LIKE $2
         AND zm.feed_until > NOW()
       ORDER BY zm.created_at DESC
       LIMIT 50`,
      [req.user.id, `${zone.slice(0, 5)}%`]
    );
    res.json({ moments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /moments/album ────────────────────────────────────────────────────────
// Álbum histórico de un usuario (todos sus momentos)
router.get('/album', auth, async (req, res) => {
  const userId = req.query.userId || req.user.id;
  try {
    const result = await pool.query(
      `SELECT zm.id, zm.image_url, zm.caption, zm.created_at, zm.zone,
              mw.started_at AS moment_time
       FROM zas_moments zm
       JOIN moment_windows mw ON mw.id = zm.window_id
       WHERE zm.user_id = $1
       ORDER BY zm.created_at DESC`,
      [userId]
    );
    const streakRes = await pool.query(
      `SELECT momento_streak FROM user_streaks WHERE user_id=$1`, [userId]
    );
    res.json({
      moments: result.rows,
      total: result.rows.length,
      streak: streakRes.rows[0]?.momento_streak || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Cron: disparar el Momento ZAS diario ──────────────────────────────────────
// Exportamos la función para llamarla desde index.js

async function scheduleDailyMomento(app) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await pool.query(
    `SELECT 1 FROM moment_windows WHERE date=$1`, [today]
  );
  if (existing.rows.length > 0) {
    console.log('📸 Momento ZAS: ya existe ventana para hoy');
    return;
  }

  // Hora aleatoria entre 9:00 y 21:55 (hora local del servidor = UTC)
  const now       = new Date();
  const minHour   = 9, maxHour = 21, maxMin = 55;
  const todayStart = new Date();
  todayStart.setHours(minHour, 0, 0, 0);

  const totalMinutes = (maxHour - minHour) * 60 + maxMin;
  const randomMin    = Math.floor(Math.random() * totalMinutes);
  const fireAt       = new Date(todayStart.getTime() + randomMin * 60 * 1000);

  // Si ya pasó la hora, esperar al día siguiente (no debería pasar en condiciones normales)
  if (fireAt <= now) {
    console.log('📸 Momento ZAS: hora aleatoria ya pasó hoy, esperando mañana');
    scheduleNextDay(app);
    return;
  }

  const msUntilFire = fireAt.getTime() - now.getTime();
  console.log(`📸 Momento ZAS: programado para las ${fireAt.toISOString()} (en ${Math.round(msUntilFire/60000)} min)`);

  setTimeout(async () => {
    try {
      const startsAt  = new Date();
      const expiresAt = new Date(startsAt.getTime() + WINDOW_MINUTES * 60 * 1000);
      const todayDate = startsAt.toISOString().slice(0, 10);

      const winRes = await pool.query(
        `INSERT INTO moment_windows (date, started_at, expires_at, notified)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (date) DO NOTHING RETURNING *`,
        [todayDate, startsAt, expiresAt]
      );
      if (!winRes.rows.length) return; // ya existe

      // Enviar push a TODOS los usuarios con token registrado
      const tokens = await pool.query(`SELECT user_id FROM push_tokens`);
      console.log(`📸 Momento ZAS: enviando push a ${tokens.rows.length} usuarios`);

      for (const { user_id } of tokens.rows) {
        sendPush(user_id, {
          title: '⚡ ¡Es tu Momento ZAS!',
          body:  '📸 Tienes 5 minutos para subir tu foto. ¡No lo dejes escapar!',
          data:  { type: 'momento_zas', window_id: winRes.rows[0].id },
        });
      }

      // Emitir por socket a todos los conectados
      const io = app?.get('io');
      if (io) io.emit('momento_zas_start', { expires_at: expiresAt, window_id: winRes.rows[0].id });

      // Programar siguiente día
      scheduleNextDay(app);
    } catch (err) {
      console.error('Momento ZAS cron error:', err);
    }
  }, msUntilFire);
}

function scheduleNextDay(app) {
  // Llamar scheduleDailyMomento a las 00:01 del día siguiente
  const now       = new Date();
  const tomorrow  = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 1, 0, 0);
  const ms = tomorrow.getTime() - now.getTime();
  setTimeout(() => scheduleDailyMomento(app), ms);
  console.log(`📸 Momento ZAS: próxima programación en ${Math.round(ms/3600000)}h`);
}

module.exports = router;
module.exports.scheduleDailyMomento = scheduleDailyMomento;
