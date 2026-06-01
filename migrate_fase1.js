require('dotenv').config();
const pool = require('./db/pool');

// ─── MIGRACIÓN FASE 1: Monedas, Retos y Rachas ───────────────────────────────
// Ejecutar UNA SOLA VEZ sobre la BD que ya tiene el schema de Fase 0.
// Es idempotente: usa IF NOT EXISTS y ON CONFLICT DO NOTHING.

const FASE1_SCHEMA = `

-- ── Monedas ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_coins (
    user_id   UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    coins     INT  DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Límites diarios de ganancia de monedas
CREATE TABLE IF NOT EXISTS coin_daily_limits (
    user_id      UUID  REFERENCES users(id) ON DELETE CASCADE,
    action       VARCHAR(30),   -- 'post' | 'message' | 'upvote_received'
    day          DATE DEFAULT CURRENT_DATE,
    count        INT  DEFAULT 0,
    PRIMARY KEY (user_id, action, day)
);

-- Historial de transacciones (para mostrar al usuario)
CREATE TABLE IF NOT EXISTS coin_transactions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    delta       INT  NOT NULL,          -- positivo = ganancia, negativo = gasto
    reason      VARCHAR(60) NOT NULL,   -- 'post', 'message', 'upvote_received', 'challenge', 'buy_name', etc.
    created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id, created_at DESC);

-- ── Retos ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS challenges (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    description  TEXT,
    type         VARCHAR(10) CHECK (type IN ('daily','weekly','monthly')),
    metric       VARCHAR(30) NOT NULL,  -- 'posts_created' | 'upvotes_received'
    goal_value   INT  NOT NULL,
    reward_coins INT  DEFAULT 0,
    reward_karma INT  DEFAULT 0,
    badge_name   VARCHAR(50)            -- NULL si no da badge
);

INSERT INTO challenges (name, description, type, metric, goal_value, reward_coins, reward_karma, badge_name) VALUES
  ('Escritor del día',      'Publica 3 posts hoy',                    'daily',   'posts_created',    3,  10,  5,   NULL),
  ('Popular del día',       'Consigue 5 upvotes hoy',                 'daily',   'upvotes_received', 5,  15,  10,  NULL),
  ('Influencer semanal',    'Consigue 50 upvotes esta semana',         'weekly',  'upvotes_received', 50, 100, 25,  'Popular'),
  ('Leyenda del mes',       'Acumula más karma que 90% de tu zona',   'monthly', 'karma_rank',        1,  500, 100, 'Leyenda')
ON CONFLICT DO NOTHING;

-- Progreso individual por periodo
CREATE TABLE IF NOT EXISTS user_challenges (
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    challenge_id INT  REFERENCES challenges(id) ON DELETE CASCADE,
    period_key   VARCHAR(20) NOT NULL,  -- '2025-05-27' | '2025-W22' | '2025-05'
    progress     INT  DEFAULT 0,
    completed    BOOLEAN DEFAULT false,
    claimed      BOOLEAN DEFAULT false,
    PRIMARY KEY (user_id, challenge_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_user_challenges_user ON user_challenges(user_id, period_key);

-- ── Rachas ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_streaks (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak  INT  DEFAULT 0,
    longest_streak  INT  DEFAULT 0,
    last_active_date DATE
);

-- Inicializar user_coins y user_streaks para usuarios existentes
INSERT INTO user_coins (user_id, coins)
  SELECT id, 0 FROM users
  ON CONFLICT DO NOTHING;

INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_active_date)
  SELECT id, 0, 0, NULL FROM users
  ON CONFLICT DO NOTHING;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running Fase 1 migration...');
    await client.query(FASE1_SCHEMA);
    console.log('✅ Fase 1 schema applied successfully');
  } catch (err) {
    console.error('❌ Fase 1 migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
