/**
 * routes/dopamine.js — Sistema de dopamina ZAS
 * Daily claim, achievements, nivel, duelos, zona en llamas
 */
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { auth } = require('../middleware/auth');
const { sendPush } = require('../services/push');

// ── Helpers ───────────────────────────────────────────────────────────────────
function karmaToLevel(karma) {
  // Cada nivel requiere más karma: nivel N requiere N*N*10 karma acumulado
  let level = 1;
  while (karma >= level * level * 10) level++;
  return level - 1 || 1;
}

function levelProgress(karma) {
  const level    = karmaToLevel(karma);
  const current  = (level - 1) * (level - 1) * 10;
  const next     = level * level * 10;
  return { level, current: karma - current, needed: next - current, pct: Math.min(1, (karma - current) / (next - current)) };
}

// Premios del sobre diario según racha
function dailyReward(streak) {
  // Día 7, 14, 30 → premio especial
  if (streak % 30 === 0) return { coins: 200, special: '🌟 Legendario' };
  if (streak % 14 === 0) return { coins: 100, special: '💎 Épico' };
  if (streak %  7 === 0) return { coins:  50, special: '🔥 Semana completa' };
  // Variable: entre 5 y 30 con algo de azar
  const base  = Math.min(5 + streak * 2, 30);
  const bonus = Math.random() < 0.2 ? Math.floor(Math.random() * 20) + 10 : 0; // 20% de jackpot
  return { coins: base + bonus, special: bonus > 0 ? '🎰 ¡Jackpot!' : null };
}

// Unlock achievement helper
async function unlockAchievement(client, userId, key) {
  try {
    const { rowCount } = await client.query(
      `INSERT INTO user_achievements (user_id, achievement) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, key]
    );
    if (rowCount > 0) {
      const { rows } = await client.query(`SELECT * FROM achievements WHERE key=$1`, [key]);
      if (rows[0]) {
        await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [rows[0].coins, userId]);
        sendPush(userId, { title: '🏆 ¡Logro desbloqueado!', body: `${rows[0].icon} ${rows[0].name} — +${rows[0].coins} 🪙` });
        return rows[0];
      }
    }
  } catch {}
  return null;
}

// ── GET /dopamine/level ───────────────────────────────────────────────────────
router.get('/level', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT karma FROM users WHERE id=$1`, [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(levelProgress(rows[0].karma));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dopamine/daily-claim ─────────────────────────────────────────────────
router.post('/daily-claim', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Comprobar si ya reclamó hoy
    const today = new Date().toISOString().slice(0, 10);
    const already = await client.query(
      `SELECT id FROM daily_claims WHERE user_id=$1 AND day=$2`,
      [req.user.id, today]
    );
    if (already.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ya reclamaste hoy', already_claimed: true });
    }

    // Calcular racha de login
    const streakRow = await client.query(
      `SELECT login_streak, last_login FROM user_streaks WHERE user_id=$1`,
      [req.user.id]
    );
    let loginStreak = 1;
    if (streakRow.rows[0]) {
      const last = streakRow.rows[0].last_login;
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const wasYesterday = last && last.toISOString().slice(0, 10) === yesterday.toISOString().slice(0, 10);
      loginStreak = wasYesterday ? (streakRow.rows[0].login_streak || 0) + 1 : 1;
    }

    // Calcular premio
    const reward = dailyReward(loginStreak);

    // Insertar claim
    await client.query(
      `INSERT INTO daily_claims (user_id, day, streak, coins) VALUES ($1, $2, $3, $4)`,
      [req.user.id, today, loginStreak, reward.coins]
    );

    // Dar monedas
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [reward.coins, req.user.id]);

    // Actualizar racha de login
    await client.query(
      `INSERT INTO user_streaks (user_id, login_streak, last_login)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET login_streak=$2, last_login=$3`,
      [req.user.id, loginStreak, today]
    );

    // Combo multiplier: si racha >= 3, activar x1.5; >= 7, x2
    let multiplier = 1.0;
    let comboUntil = null;
    if (loginStreak >= 7) {
      multiplier = 2.0;
      comboUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    } else if (loginStreak >= 3) {
      multiplier = 1.5;
      comboUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }
    if (multiplier > 1) {
      await client.query(
        `UPDATE user_streaks SET combo_multiplier=$1, combo_until=$2 WHERE user_id=$3`,
        [multiplier, comboUntil, req.user.id]
      );
    }

    // Logros de racha
    if (loginStreak >= 3)  await unlockAchievement(client, req.user.id, 'streak_3');
    if (loginStreak >= 7)  await unlockAchievement(client, req.user.id, 'streak_7');
    if (loginStreak >= 30) await unlockAchievement(client, req.user.id, 'streak_30');
    if (multiplier >= 2)   await unlockAchievement(client, req.user.id, 'combo_x2');

    // Logro de 7 días de sobre
    const claimCount = await client.query(
      `SELECT COUNT(*) FROM daily_claims WHERE user_id=$1`, [req.user.id]
    );
    if (parseInt(claimCount.rows[0].count) >= 7) {
      await unlockAchievement(client, req.user.id, 'daily_7');
    }

    await client.query('COMMIT');

    const { rows: updated } = await pool.query(`SELECT coins FROM users WHERE id=$1`, [req.user.id]);
    res.json({
      ok: true,
      coins_earned:  reward.coins,
      special:       reward.special,
      login_streak:  loginStreak,
      multiplier,
      combo_until:   comboUntil,
      total_coins:   updated[0].coins,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Daily claim error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET /dopamine/daily-status ────────────────────────────────────────────────
router.get('/daily-status', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const claim = await pool.query(
      `SELECT * FROM daily_claims WHERE user_id=$1 AND day=$2`, [req.user.id, today]
    );
    const streak = await pool.query(
      `SELECT login_streak, combo_multiplier, combo_until FROM user_streaks WHERE user_id=$1`, [req.user.id]
    );
    const s = streak.rows[0] || {};
    res.json({
      claimed_today:    claim.rows.length > 0,
      login_streak:     s.login_streak || 0,
      combo_multiplier: parseFloat(s.combo_multiplier) || 1.0,
      combo_active:     s.combo_until && new Date(s.combo_until) > new Date(),
      next_reward:      dailyReward((s.login_streak || 0) + 1),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dopamine/achievements ────────────────────────────────────────────────
router.get('/achievements', auth, async (req, res) => {
  try {
    // Logros desbloqueados
    const { rows: unlocked } = await pool.query(
      `SELECT ua.achievement as key, ua.unlocked_at, a.name, a.description, a.icon, a.coins, a.hidden
       FROM user_achievements ua JOIN achievements a ON a.key = ua.achievement
       WHERE ua.user_id = $1 ORDER BY ua.unlocked_at DESC`,
      [req.user.id]
    );
    // Logros visibles no desbloqueados
    const { rows: available } = await pool.query(
      `SELECT key, name, description, icon, coins, hidden FROM achievements
       WHERE hidden = false AND key NOT IN (
         SELECT achievement FROM user_achievements WHERE user_id=$1
       )`,
      [req.user.id]
    );
    // Marcar como notificados
    await pool.query(
      `UPDATE user_achievements SET notified=true WHERE user_id=$1 AND notified=false`,
      [req.user.id]
    );
    res.json({ unlocked, available, total: unlocked.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dopamine/unread-achievements ─────────────────────────────────────────
router.get('/unread-achievements', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ua.achievement as key, a.name, a.icon, a.coins
       FROM user_achievements ua JOIN achievements a ON a.key=ua.achievement
       WHERE ua.user_id=$1 AND ua.notified=false`,
      [req.user.id]
    );
    res.json({ new_achievements: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Función para chequear logros (exportada, llamada desde otras rutas) ───────
async function checkAchievements(userId, trigger) {
  const client = await pool.connect();
  try {
    const { rows: userRows } = await client.query(`SELECT karma FROM users WHERE id=$1`, [userId]);
    const user = userRows[0];
    if (!user) return;

    if (trigger === 'post') {
      const { rows } = await client.query(`SELECT COUNT(*) FROM posts WHERE user_id=$1`, [userId]);
      if (parseInt(rows[0].count) === 1) await unlockAchievement(client, userId, 'first_post');
      const hour = new Date().getHours();
      if (hour < 8)  await unlockAchievement(client, userId, 'early_bird');
      if (hour >= 0 && hour < 4) await unlockAchievement(client, userId, 'night_owl');
    }
    if (trigger === 'reaction') {
      const { rows } = await client.query(`SELECT COUNT(*) FROM reactions WHERE user_id=$1`, [userId]);
      if (parseInt(rows[0].count) === 1) await unlockAchievement(client, userId, 'first_reaction');
    }
    if (trigger === 'momento') {
      const { rows } = await client.query(`SELECT COUNT(*) FROM zas_moments WHERE user_id=$1`, [userId]);
      const count = parseInt(rows[0].count);
      if (count === 1) await unlockAchievement(client, userId, 'first_momento');
      if (count >= 7) await unlockAchievement(client, userId, 'momento_7');
    }
    if (trigger === 'karma') {
      if (user.karma >= 100) await unlockAchievement(client, userId, 'secret_100karma');
    }
    if (trigger === 'top1')     await unlockAchievement(client, userId, 'top1');
    if (trigger === 'top3')     await unlockAchievement(client, userId, 'top3');
    if (trigger === 'clan')     await unlockAchievement(client, userId, 'clan_member');
    if (trigger === 'visitor')  await unlockAchievement(client, userId, 'secret_first_zone');
    if (trigger === 'treasure') await unlockAchievement(client, userId, 'treasure_first');
  } finally {
    client.release();
  }
}

// ── GET /dopamine/zona-en-llamas ──────────────────────────────────────────────
router.get('/zona-en-llamas', auth, async (req, res) => {
  try {
    const { zone } = req.query;
    if (!zone) return res.json({ active: false });
    // Actividad en la zona en la última hora
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM posts WHERE zone=$1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [zone]
    );
    const count = parseInt(rows[0].count);
    const active = count >= 10; // umbral: 10 posts en 1h
    res.json({ active, post_count: count, threshold: 10 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DUELOS ────────────────────────────────────────────────────────────────────

// POST /dopamine/duel — retar a alguien
router.post('/duel', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { challenged_id, stake_coins = 50 } = req.body;
    if (!challenged_id) return res.status(400).json({ error: 'challenged_id requerido' });
    if (challenged_id === req.user.id) return res.status(400).json({ error: 'No puedes retarte a ti mismo' });

    // Verificar monedas
    const { rows: myRows } = await client.query(`SELECT coins, karma, push_token, public_name FROM users WHERE id=$1`, [req.user.id]);
    if (!myRows[0] || myRows[0].coins < stake_coins) {
      return res.status(400).json({ error: `Necesitas ${stake_coins} 🪙 para retar` });
    }

    // No puede haber duelo activo entre ellos
    const existing = await client.query(
      `SELECT id FROM duels WHERE ((challenger_id=$1 AND challenged_id=$2) OR (challenger_id=$2 AND challenged_id=$1))
       AND status IN ('pending','active')`,
      [req.user.id, challenged_id]
    );
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Ya hay un duelo activo entre vosotros' });

    await client.query('BEGIN');

    // Reservar monedas del retador
    await client.query(`UPDATE users SET coins = coins - $1 WHERE id = $2`, [stake_coins, req.user.id]);

    // Crear duelo
    const { rows: myKarma }  = await client.query(`SELECT karma FROM users WHERE id=$1`, [req.user.id]);
    const { rows: oppRows }  = await client.query(`SELECT karma, public_name FROM users WHERE id=$1`, [challenged_id]);

    const { rows } = await client.query(
      `INSERT INTO duels (challenger_id, challenged_id, stake_coins, challenger_karma_start, challenged_karma_start)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.user.id, challenged_id, stake_coins, myKarma[0]?.karma || 0, oppRows[0]?.karma || 0]
    );

    await client.query('COMMIT');

    // Push al retado
    sendPush(challenged_id, { title: '⚔️ ¡Te han retado!', body: `${myRows[0].public_name} te desafía a un duelo de karma. Apuesta: ${stake_coins} 🪙` });

    // Logro primer duelo retador
    await unlockAchievement(client, req.user.id, 'first_duel');

    res.json({ ok: true, duel_id: rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /dopamine/duel/:id/accept
router.put('/duel/:id/accept', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT * FROM duels WHERE id=$1`, [req.params.id]);
    const duel = rows[0];
    if (!duel) return res.status(404).json({ error: 'Duelo no encontrado' });
    if (duel.challenged_id !== req.user.id) return res.status(403).json({ error: 'No eres el retado' });
    if (duel.status !== 'pending') return res.status(400).json({ error: 'Duelo ya no está pendiente' });

    // Reservar monedas del retado
    const { rows: myRows } = await client.query(`SELECT coins, push_token FROM users WHERE id=$1`, [req.user.id]);
    if (myRows[0].coins < duel.stake_coins) {
      return res.status(400).json({ error: `Necesitas ${duel.stake_coins} 🪙 para aceptar` });
    }

    await client.query('BEGIN');
    await client.query(`UPDATE users SET coins = coins - $1 WHERE id=$2`, [duel.stake_coins, req.user.id]);

    const now = new Date();
    const ends = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h

    await client.query(
      `UPDATE duels SET status='active', started_at=$1, ends_at=$2 WHERE id=$3`,
      [now, ends, duel.id]
    );
    await client.query('COMMIT');

    // Push al retador
    const { rows: myNameRows } = await client.query(`SELECT public_name FROM users WHERE id=$1`, [req.user.id]);
    sendPush(duel.challenger_id, { title: '⚔️ ¡Duelo aceptado!', body: `${myNameRows[0]?.public_name} aceptó tu reto. Tienes 24h para ganar más karma. ¡A por ello!` });

    await unlockAchievement(client, req.user.id, 'first_duel');

    res.json({ ok: true, ends_at: ends });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /dopamine/duel/:id/reject
router.put('/duel/:id/reject', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT * FROM duels WHERE id=$1`, [req.params.id]);
    const duel = rows[0];
    if (!duel || duel.challenged_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
    if (duel.status !== 'pending') return res.status(400).json({ error: 'Ya no está pendiente' });

    await client.query('BEGIN');
    await client.query(`UPDATE duels SET status='rejected' WHERE id=$1`, [duel.id]);
    // Devolver monedas al retador
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id=$2`, [duel.stake_coins, duel.challenger_id]);
    await client.query('COMMIT');

    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /dopamine/duels — mis duelos activos/pendientes
router.get('/duels', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*,
         ch.public_name as challenger_name, ch.avatar_url as challenger_avatar, ch.karma as challenger_karma_now,
         cd.public_name as challenged_name, cd.avatar_url as challenged_avatar, cd.karma as challenged_karma_now
       FROM duels d
       JOIN users ch ON ch.id = d.challenger_id
       JOIN users cd ON cd.id = d.challenged_id
       WHERE (d.challenger_id=$1 OR d.challenged_id=$1)
         AND d.status IN ('pending','active')
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );

    // Resolver duelos expirados
    for (const duel of rows.filter(d => d.status === 'active' && new Date(d.ends_at) < new Date())) {
      await resolveDuel(duel.id);
    }

    res.json({ duels: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolver duelo expirado
async function resolveDuel(duelId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT * FROM duels WHERE id=$1 AND status='active'`, [duelId]);
    const duel = rows[0];
    if (!duel) return;

    const { rows: ch } = await client.query(`SELECT karma, push_token, public_name FROM users WHERE id=$1`, [duel.challenger_id]);
    const { rows: cd } = await client.query(`SELECT karma, push_token, public_name FROM users WHERE id=$1`, [duel.challenged_id]);

    const chGain = (ch[0]?.karma || 0) - duel.challenger_karma_start;
    const cdGain = (cd[0]?.karma || 0) - duel.challenged_karma_start;

    const winnerId   = chGain >= cdGain ? duel.challenger_id : duel.challenged_id;
    const loserId    = winnerId === duel.challenger_id ? duel.challenged_id : duel.challenger_id;
    const winnerName = winnerId === duel.challenger_id ? ch[0].public_name : cd[0].public_name;

    const prize = duel.stake_coins * 2;
    await client.query('BEGIN');
    await client.query(`UPDATE duels SET status='completed', winner_id=$1, challenger_karma_end=$2, challenged_karma_end=$3 WHERE id=$4`,
      [winnerId, ch[0]?.karma, cd[0]?.karma, duelId]);
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id=$2`, [prize, winnerId]);
    await client.query('COMMIT');

    // Push
    sendPush(winnerId, { title: '⚔️ ¡Ganaste el duelo!', body: `Has ganado ${prize} 🪙. ¡Campeón!` });
    sendPush(loserId,  { title: '⚔️ Duelo terminado',    body: `${winnerName} ganó esta vez. ¡Révatele!` });

    // Logros
    await unlockAchievement(client, winnerId, 'duel_win');
    const { rows: wins } = await client.query(`SELECT COUNT(*) FROM duels WHERE winner_id=$1`, [winnerId]);
    if (parseInt(wins[0].count) >= 5) await unlockAchievement(client, winnerId, 'duel_win_5');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('resolveDuel error:', err.message);
  } finally {
    client.release();
  }
}

// Cron de resolución de duelos (llamar desde index.js cada hora)
async function scheduleDuelResolution(app) {
  setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id FROM duels WHERE status='active' AND ends_at < NOW()`
      );
      for (const { id } of rows) await resolveDuel(id);
    } catch {}
  }, 60 * 60 * 1000); // cada hora
}

module.exports = router;
module.exports.checkAchievements  = checkAchievements;
module.exports.scheduleDuelResolution = scheduleDuelResolution;
module.exports.karmaToLevel       = karmaToLevel;
module.exports.levelProgress      = levelProgress;
