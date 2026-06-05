/**
 * services/economy.js — Motor de Fase 1
 */
const pool = require('../db/pool');

const DAILY_LIMITS = {
  post:            { coins: 1,   maxPerDay: 10 },
  message:         { coins: 0.5, maxPerDay: 20 },
  upvote_received: { coins: 2,   maxPerDay: 50 },
};

const COSTS = {
  buy_name:        50,
  highlight_post:  100,
  create_channel:  200,
  create_treasure: 50,
  create_poll:     30,
  travel_zone:     50,
};

// ─── awardCoins ───────────────────────────────────────────────────────────────
async function awardCoins(userId, action, client = null) {
  const cfg = DAILY_LIMITS[action];
  if (!cfg) return 0;
  const db    = client || pool;
  const today = new Date().toISOString().slice(0, 10);

  const limitRow = await db.query(
    `INSERT INTO coin_daily_limits (user_id, action, day, count)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (user_id, action, day) DO UPDATE SET count = coin_daily_limits.count
     RETURNING count`,
    [userId, action, today]
  );
  if (limitRow.rows[0].count >= cfg.maxPerDay) return 0;

  const earned = cfg.coins;
  await db.query(
    'UPDATE coin_daily_limits SET count=count+1 WHERE user_id=$1 AND action=$2 AND day=$3',
    [userId, action, today]
  );
  await db.query(
    `INSERT INTO user_coins (user_id, coins) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET coins=user_coins.coins+$2, updated_at=NOW()`,
    [userId, earned]
  );
  await db.query(
    'INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,$2,$3)',
    [userId, earned, action]
  );
  return earned;
}

// ─── spendCoins ───────────────────────────────────────────────────────────────
async function spendCoins(userId, action, client = null) {
  const cost = COSTS[action];
  if (!cost) throw new Error(`Unknown spend action: ${action}`);
  const db = client || pool;

  const result = await db.query(
    'SELECT coins FROM user_coins WHERE user_id=$1 FOR UPDATE',
    [userId]
  );
  const current = result.rows[0]?.coins ?? 0;
  if (current < cost) throw new Error('INSUFFICIENT_COINS');

  await db.query(
    'UPDATE user_coins SET coins=coins-$1, updated_at=NOW() WHERE user_id=$2',
    [cost, userId]
  );
  await db.query(
    'INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,$2,$3)',
    [userId, -cost, action]
  );
  return cost;
}

// ─── getCoins ─────────────────────────────────────────────────────────────────
async function getCoins(userId) {
  const result = await pool.query(
    'SELECT coins FROM user_coins WHERE user_id=$1', [userId]
  );
  return result.rows[0]?.coins ?? 0;
}

// ─── updateStreak ─────────────────────────────────────────────────────────────
async function updateStreak(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await pool.query(
    'SELECT * FROM user_streaks WHERE user_id=$1', [userId]
  );

  if (result.rows.length === 0) {
    await pool.query(
      `INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_active_date)
       VALUES ($1, 1, 1, $2)`,
      [userId, today]
    );
    return;
  }

  const streak = result.rows[0];
  if (streak.last_active_date === today) return; // ya se contó hoy

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);

  const newStreak = streak.last_active_date === yStr
    ? streak.current_streak + 1
    : 1;

  await pool.query(
    `UPDATE user_streaks
     SET current_streak=$1, longest_streak=GREATEST(longest_streak,$1),
         last_active_date=$2
     WHERE user_id=$3`,
    [newStreak, today, userId]
  );
}

// ─── updateChallengeProgress ──────────────────────────────────────────────────
async function updateChallengeProgress(userId, metric, db = null) {
  const client = db || pool;
  const now = new Date();

  // Buscar retos activos para esta métrica
  const challenges = await client.query(
    `SELECT * FROM challenges WHERE metric = $1`, [metric]
  );
  if (challenges.rows.length === 0) return [];

  const completed = [];

  for (const ch of challenges.rows) {
    const periodKey = getPeriodKey(ch.type, now);

    // Upsert del progreso — ON CONFLICT para evitar duplicados
    const uc = await client.query(
      `INSERT INTO user_challenges (user_id, challenge_id, period_key, progress, completed, claimed)
       VALUES ($1, $2, $3, 1, false, false)
       ON CONFLICT (user_id, challenge_id, period_key)
       DO UPDATE SET
         progress = CASE
           WHEN user_challenges.completed THEN user_challenges.progress
           ELSE user_challenges.progress + 1
         END
       RETURNING *`,
      [userId, ch.id, periodKey]
    );

    const row = uc.rows[0];

    // Completar si alcanzó el objetivo y no estaba completado
    if (!row.completed && row.progress >= ch.goal_value) {
      await client.query(
        `UPDATE user_challenges SET completed=true
         WHERE user_id=$1 AND challenge_id=$2 AND period_key=$3`,
        [userId, ch.id, periodKey]
      );

      // Dar recompensas (solo una vez)
      if (ch.reward_coins > 0) {
        await client.query(
          `INSERT INTO user_coins (user_id, coins) VALUES ($1,$2)
           ON CONFLICT (user_id) DO UPDATE SET coins=user_coins.coins+$2, updated_at=NOW()`,
          [userId, ch.reward_coins]
        );
        await client.query(
          'INSERT INTO coin_transactions (user_id, delta, reason) VALUES ($1,$2,$3)',
          [userId, ch.reward_coins, `challenge_${ch.id}`]
        );
      }
      if (ch.reward_karma > 0) {
        await client.query(
          'UPDATE users SET karma=karma+$1 WHERE id=$2',
          [ch.reward_karma, userId]
        );
      }

      completed.push({
        id: ch.id, name: ch.name,
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
  if (type === 'daily')   return date.toISOString().slice(0, 10);
  if (type === 'monthly') return date.toISOString().slice(0, 7);
  if (type === 'weekly') {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const week1 = new Date(d.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(
      ((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
    );
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }
  return date.toISOString().slice(0, 10);
}

// ─── getChallengesForUser ─────────────────────────────────────────────────────
// UNA SOLA QUERY — sin duplicados
async function getChallengesForUser(userId) {
  const now = new Date();
  const result = await pool.query(
    `SELECT
       c.id, c.name, c.description, c.type, c.metric, c.goal_value,
       c.reward_coins, c.reward_karma, c.badge_name,
       COALESCE(uc.progress, 0)       AS progress,
       COALESCE(uc.completed, false)  AS completed,
       COALESCE(uc.claimed, false)    AS claimed
     FROM challenges c
     LEFT JOIN user_challenges uc
       ON  uc.challenge_id = c.id
       AND uc.user_id      = $1
       AND uc.period_key   = CASE c.type
             WHEN 'daily'   THEN $2
             WHEN 'weekly'  THEN $3
             WHEN 'monthly' THEN $4
           END
     ORDER BY
       CASE c.type WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END,
       c.id`,
    [
      userId,
      getPeriodKey('daily',   now),
      getPeriodKey('weekly',  now),
      getPeriodKey('monthly', now),
    ]
  );
  return result.rows;
}

// ─── getTransactionHistory ────────────────────────────────────────────────────
async function getTransactionHistory(userId, limit = 30) {
  const result = await pool.query(
    `SELECT delta, reason, created_at
     FROM coin_transactions
     WHERE user_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = {
  awardCoins, spendCoins, getCoins,
  updateStreak, updateChallengeProgress,
  getChallengesForUser, getTransactionHistory,
  getPeriodKey, COSTS, DAILY_LIMITS,
};
