/**
 * economy.js  —  Motor central de Fase 1
 * Maneja monedas, límites diarios, rachas y progreso de retos.
 * Todas las funciones reciben un `client` de pg para operar dentro de transacciones.
 */

const pool = require('../db/pool');

// ─── Límites diarios de ganancia ─────────────────────────────────────────────
const DAILY_LIMITS = {
  post:             { coins: 1,   maxPerDay: 10 },
  message:          { coins: 0.5, maxPerDay: 20 },
  upvote_received:  { coins: 2,   maxPerDay: 50 },
};

// Costes de gasto
const COSTS = {
  buy_name:         50,
  highlight_post:   100,
  create_channel:   200,
  create_treasure:  50,
  create_poll:      30,
  travel_zone:      50,
};

// ─── awardCoins ───────────────────────────────────────────────────────────────
// Otorga monedas respetando el límite diario. Devuelve las monedas realmente ganadas.
async function awardCoins(userId, action, client = null) {
  const cfg = DAILY_LIMITS[action];
  if (!cfg) return 0;

  const db = client || pool;
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  // Leer / crear registro de límite diario
  const limitRow = await db.query(
    `INSERT INTO coin_daily_limits (user_id, action, day, count)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (user_id, action, day) DO UPDATE SET count = coin_daily_limits.count
     RETURNING count`,
    [userId, action, today]
  );

  const usedToday = limitRow.rows[0].count;
  if (usedToday >= cfg.maxPerDay) return 0; // límite alcanzado

  const earned = cfg.coins;

  // Incrementar contador diario
  await db.query(
    `UPDATE coin_daily_limits SET count = count + 1
     WHERE user_id = $1 AND action = $2 AND day = $3`,
    [userId, action, today]
  );

  // Añadir monedas al saldo
  await db.query(
    `INSERT INTO user_coins (user_id, coins) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET coins = user_coins.coins + $2, updated_at = NOW()`,
    [userId, earned]
  );

  // Registrar transacción
  await db.query(
    `INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1, $2, $3)`,
    [userId, earned, action]
  );

  return earned;
}

// ─── spendCoins ───────────────────────────────────────────────────────────────
// Gasta monedas si el saldo es suficiente. Lanza error si no alcanza.
async function spendCoins(userId, action, client = null) {
  const cost = COSTS[action];
  if (!cost) throw new Error(`Unknown spend action: ${action}`);

  const db = client || pool;

  const result = await db.query(
    `UPDATE user_coins SET coins = coins - $1, updated_at = NOW()
     WHERE user_id = $2 AND coins >= $1
     RETURNING coins`,
    [cost, userId]
  );

  if (result.rows.length === 0) {
    throw new Error('INSUFFICIENT_COINS');
  }

  await db.query(
    `INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1, $2, $3)`,
    [userId, -cost, action]
  );

  return result.rows[0].coins; // saldo restante
}

// ─── getCoins ─────────────────────────────────────────────────────────────────
async function getCoins(userId) {
  const result = await pool.query(
    'SELECT coins FROM user_coins WHERE user_id = $1',
    [userId]
  );
  return result.rows[0]?.coins ?? 0;
}

// ─── updateStreak ─────────────────────────────────────────────────────────────
// Llama una vez por día cuando el usuario hace cualquier acción.
// Devuelve { current_streak, longest_streak, broke_streak }
async function updateStreak(userId, client = null) {
  const db = client || pool;
  const today = new Date().toISOString().slice(0, 10);

  const row = await db.query(
    'SELECT * FROM user_streaks WHERE user_id = $1',
    [userId]
  );

  if (row.rows.length === 0) {
    await db.query(
      `INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_active_date)
       VALUES ($1, 1, 1, $2)`,
      [userId, today]
    );
    return { current_streak: 1, longest_streak: 1, broke_streak: false };
  }

  const streak = row.rows[0];
  const last = streak.last_active_date
    ? new Date(streak.last_active_date).toISOString().slice(0, 10)
    : null;

  if (last === today) {
    // Ya registrado hoy, no hacer nada
    return {
      current_streak: streak.current_streak,
      longest_streak: streak.longest_streak,
      broke_streak: false,
    };
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const isConsecutive = last === yesterday;

  const newCurrent = isConsecutive ? streak.current_streak + 1 : 1;
  const newLongest = Math.max(newCurrent, streak.longest_streak);
  const brokePreviousStreak = !isConsecutive && streak.current_streak > 1;

  await db.query(
    `UPDATE user_streaks
     SET current_streak = $1, longest_streak = $2, last_active_date = $3
     WHERE user_id = $4`,
    [newCurrent, newLongest, today, userId]
  );

  return {
    current_streak: newCurrent,
    longest_streak: newLongest,
    broke_streak: brokePreviousStreak,
  };
}

// ─── updateChallengeProgress ──────────────────────────────────────────────────
// Incrementa el progreso del reto correspondiente y otorga recompensa si se completa.
// metric: 'posts_created' | 'upvotes_received'
// Devuelve lista de retos completados en esta llamada (puede ser vacía).
async function updateChallengeProgress(userId, metric, increment = 1, client = null) {
  const db = client || pool;
  const now = new Date();
  const completed = [];

  // Obtener todos los retos activos con esta métrica
  const challenges = await db.query(
    `SELECT * FROM challenges WHERE metric = $1`,
    [metric]
  );

  for (const ch of challenges.rows) {
    const periodKey = getPeriodKey(ch.type, now);

    // Upsert progreso
    const result = await db.query(
      `INSERT INTO user_challenges (user_id, challenge_id, period_key, progress, completed, claimed)
       VALUES ($1, $2, $3, $4, false, false)
       ON CONFLICT (user_id, challenge_id, period_key) DO UPDATE
         SET progress = CASE
           WHEN user_challenges.completed THEN user_challenges.progress  -- no sobreescribir
           ELSE user_challenges.progress + $4
         END
       RETURNING progress, completed`,
      [userId, ch.id, periodKey, increment]
    );

    const { progress, completed: alreadyDone } = result.rows[0];
    if (!alreadyDone && progress >= ch.goal_value) {
      // ¡Completado! Marcar y otorgar recompensa
      await db.query(
        `UPDATE user_challenges SET completed = true WHERE user_id = $1 AND challenge_id = $2 AND period_key = $3`,
        [userId, ch.id, periodKey]
      );

      // Monedas de recompensa (sin límite diario)
      if (ch.reward_coins > 0) {
        await db.query(
          `INSERT INTO user_coins (user_id, coins) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET coins = user_coins.coins + $2, updated_at = NOW()`,
          [userId, ch.reward_coins]
        );
        await db.query(
          `INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1, $2, $3)`,
          [userId, ch.reward_coins, `challenge_${ch.id}`]
        );
      }

      // Karma de recompensa
      if (ch.reward_karma > 0) {
        await db.query(
          'UPDATE users SET karma = karma + $1 WHERE id = $2',
          [ch.reward_karma, userId]
        );
      }

      completed.push({
        id: ch.id,
        name: ch.name,
        reward_coins: ch.reward_coins,
        reward_karma: ch.reward_karma,
        badge_name: ch.badge_name,
      });
    }
  }

  return completed;
}

// ─── getPeriodKey ─────────────────────────────────────────────────────────────
function getPeriodKey(type, date = new Date()) {
  if (type === 'daily') return date.toISOString().slice(0, 10);           // '2025-05-27'
  if (type === 'weekly') {
    // ISO week key: '2025-W22'
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const week1 = new Date(d.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }
  if (type === 'monthly') return date.toISOString().slice(0, 7);          // '2025-05'
  return date.toISOString().slice(0, 10);
}

// ─── getChallengesForUser ─────────────────────────────────────────────────────
// Devuelve todos los retos con estado actual del usuario para mostrar en UI.
async function getChallengesForUser(userId) {
  const now = new Date();

  const result = await pool.query(
    `SELECT
       c.id, c.name, c.description, c.type, c.goal_value,
       c.reward_coins, c.reward_karma, c.badge_name,
       COALESCE(uc.progress, 0)   AS progress,
       COALESCE(uc.completed, false) AS completed,
       COALESCE(uc.claimed, false)   AS claimed
     FROM challenges c
     LEFT JOIN user_challenges uc
       ON uc.challenge_id = c.id
      AND uc.user_id = $1
      AND uc.period_key = $2
     ORDER BY c.type, c.id`,
    // usamos la clave del periodo actual por tipo. Como hay tres tipos diferentes
    // necesitamos una consulta por tipo, o simplificar con CASE
    [userId, getPeriodKey('daily', now)]  // placeholder, ver abajo
  );

  // Consulta real que maneja múltiples tipos de periodo
  const full = await pool.query(
    `SELECT
       c.id, c.name, c.description, c.type, c.metric, c.goal_value,
       c.reward_coins, c.reward_karma, c.badge_name,
       COALESCE(uc.progress, 0)      AS progress,
       COALESCE(uc.completed, false) AS completed,
       COALESCE(uc.claimed, false)   AS claimed
     FROM challenges c
     LEFT JOIN user_challenges uc
       ON uc.challenge_id = c.id
      AND uc.user_id = $1
      AND uc.period_key = CASE c.type
            WHEN 'daily'   THEN $2
            WHEN 'weekly'  THEN $3
            WHEN 'monthly' THEN $4
          END
     ORDER BY c.type, c.id`,
    [
      userId,
      getPeriodKey('daily', now),
      getPeriodKey('weekly', now),
      getPeriodKey('monthly', now),
    ]
  );

  return full.rows;
}

// ─── getTransactionHistory ────────────────────────────────────────────────────
async function getTransactionHistory(userId, limit = 30) {
  const result = await pool.query(
    `SELECT delta, reason, created_at
     FROM coin_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = {
  awardCoins,
  spendCoins,
  getCoins,
  updateStreak,
  updateChallengeProgress,
  getChallengesForUser,
  getTransactionHistory,
  getPeriodKey,
  COSTS,
  DAILY_LIMITS,
};
