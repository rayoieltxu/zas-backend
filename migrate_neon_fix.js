/**
 * migrate_neon_fix.js
 * Añade columnas de auth a tabla users existente en Neon
 * y crea tablas/índices que falten.
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SQL = `
-- Añadir columnas de auth si no existen
ALTER TABLE users ADD COLUMN IF NOT EXISTS email           VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash   VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token    VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires  TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token     VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires   TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url      VARCHAR(500);
ALTER TABLE users ADD COLUMN IF NOT EXISTS school_id       UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_links    JSONB DEFAULT '{}';

-- Índices
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token);
CREATE INDEX IF NOT EXISTS idx_users_reset_token  ON users(reset_token);

-- Resto de tablas que puedan faltar (IF NOT EXISTS = seguro)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS user_coins (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    coins      INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_streaks (
    user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak   INT DEFAULT 0,
    longest_streak   INT DEFAULT 0,
    last_active_date DATE
);
CREATE TABLE IF NOT EXISTS push_tokens (
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    token      VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, token)
);
CREATE TABLE IF NOT EXISTS follows (
    follower_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

CREATE TABLE IF NOT EXISTS shop_items (
    id          SERIAL PRIMARY KEY,
    key         VARCHAR(50) UNIQUE NOT NULL,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    price_coins INT NOT NULL,
    category    VARCHAR(30),
    effect      JSONB DEFAULT '{}',
    active      BOOLEAN DEFAULT true
);
CREATE TABLE IF NOT EXISTS user_inventory (
    id        SERIAL PRIMARY KEY,
    user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
    item_key  VARCHAR(50) REFERENCES shop_items(key),
    quantity  INT DEFAULT 1,
    equipped  BOOLEAN DEFAULT false,
    bought_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, item_key)
);
CREATE TABLE IF NOT EXISTS daily_claims (
    id         SERIAL PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day        DATE NOT NULL DEFAULT CURRENT_DATE,
    streak     INTEGER NOT NULL DEFAULT 1,
    coins      INTEGER NOT NULL DEFAULT 0,
    item_key   TEXT,
    claimed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, day)
);
CREATE TABLE IF NOT EXISTS achievements (
    key         TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    icon        TEXT NOT NULL,
    coins       INTEGER DEFAULT 0,
    hidden      BOOLEAN DEFAULT true
);
CREATE TABLE IF NOT EXISTS user_achievements (
    id          SERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement TEXT NOT NULL REFERENCES achievements(key),
    unlocked_at TIMESTAMPTZ DEFAULT NOW(),
    notified    BOOLEAN DEFAULT false,
    UNIQUE(user_id, achievement)
);
CREATE TABLE IF NOT EXISTS coin_daily_limits (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    action  VARCHAR(30),
    day     DATE DEFAULT CURRENT_DATE,
    count   INT  DEFAULT 0,
    PRIMARY KEY (user_id, action, day)
);
CREATE TABLE IF NOT EXISTS coin_transactions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    delta      INT NOT NULL,
    reason     VARCHAR(60) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS duels (
    id            SERIAL PRIMARY KEY,
    challenger_id UUID NOT NULL REFERENCES users(id),
    challenged_id UUID NOT NULL REFERENCES users(id),
    stake_coins   INTEGER DEFAULT 50,
    status        TEXT DEFAULT 'pending',
    started_at    TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
    winner_id     UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS monthly_top (
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    period_key VARCHAR(7) NOT NULL,
    zone       VARCHAR(12),
    score      INT DEFAULT 0,
    rank       INT,
    PRIMARY KEY (user_id, period_key)
);
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log('🔗 Conectando a Neon...');
    await client.query('SELECT 1');
    console.log('✅ Conexión OK');
    console.log('🔧 Aplicando cambios...');
    await client.query(SQL);
    console.log('✅ Schema actualizado correctamente');

    const { rows } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='users' ORDER BY ordinal_position
    `);
    console.log('\n📋 Columnas de users:', rows.map(r => r.column_name).join(', '));

    const { rows: tables } = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename
    `);
    console.log('📋 Tablas:', tables.map(r => r.tablename).join(', '));
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
