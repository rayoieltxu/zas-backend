require('dotenv').config();
const pool = require('./db/pool');

const SCHEMA = `
-- =====================
-- FASE 0: NÚCLEO
-- =====================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_name VARCHAR(50) NOT NULL,
    name_history JSONB DEFAULT '[]',
    karma INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    last_active TIMESTAMP DEFAULT NOW(),
    current_geohash VARCHAR(10) NOT NULL,
    radius_km DECIMAL(3,1) DEFAULT 2.0,
    is_under_16 BOOLEAN DEFAULT false,
    device_id VARCHAR(255) UNIQUE NOT NULL,
    name_changed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    text VARCHAR(500) NOT NULL,
    upvotes INT DEFAULT 0,
    downvotes INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    geohash_zone VARCHAR(10) NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    value SMALLINT CHECK (value IN (-1, 1)),
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id VARCHAR(10) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    text VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Índices para rendimiento
CREATE INDEX IF NOT EXISTS idx_posts_geohash ON posts(geohash_zone);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_zone ON chat_messages(zone_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_geohash ON users(current_geohash);
CREATE INDEX IF NOT EXISTS idx_users_device ON users(device_id);

-- =====================
-- FASE 1: MONEDAS Y RETOS (comentado, listo para activar)
-- =====================

/*
CREATE TABLE IF NOT EXISTS user_coins (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    coins INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS challenges (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    description TEXT,
    type VARCHAR(10) CHECK (type IN ('daily', 'weekly', 'monthly')),
    goal_value INT,
    reward_coins INT,
    reward_karma INT,
    badge_name VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS user_challenges (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    challenge_id INT REFERENCES challenges(id) ON DELETE CASCADE,
    progress INT DEFAULT 0,
    completed BOOLEAN DEFAULT false,
    claimed BOOLEAN DEFAULT false,
    PRIMARY KEY (user_id, challenge_id)
);

CREATE TABLE IF NOT EXISTS user_streaks (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak INT DEFAULT 0,
    longest_streak INT DEFAULT 0,
    last_active_date DATE
);

INSERT INTO challenges (name, description, type, goal_value, reward_coins, reward_karma, badge_name) VALUES
('Escritor del día', 'Publica 3 posts hoy', 'daily', 3, 10, 5, NULL),
('Popular del día', 'Consigue 5 upvotes hoy', 'daily', 5, 15, 10, NULL),
('Influencer semanal', 'Consigue 50 upvotes esta semana', 'weekly', 50, 100, 25, 'Popular'),
('Leyenda del mes', 'Top 10 karma este mes', 'monthly', 10, 500, 100, 'Leyenda')
ON CONFLICT DO NOTHING;
*/

-- =====================
-- FASE 2: CAOS + TESOROS + TERMÓMETRO (comentado)
-- =====================

/*
CREATE TABLE IF NOT EXISTS treasures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    geohash VARCHAR(10) NOT NULL,
    hint TEXT,
    reward_coins INT DEFAULT 25,
    reward_karma INT DEFAULT 10,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    found_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    found_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS polls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question VARCHAR(200),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    zone_geohash VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id UUID REFERENCES polls(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    vote BOOLEAN,
    PRIMARY KEY (poll_id, user_id)
);
*/

-- =====================
-- FASE 3: CANALES + CLANES + VERIFICACIÓN (comentado)
-- =====================

/*
CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50),
    description TEXT,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    zone_geohash VARCHAR(10),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    is_moderator BOOLEAN DEFAULT false,
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS clans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(30),
    tag VARCHAR(6),
    leader_id UUID REFERENCES users(id) ON DELETE SET NULL,
    zone_geohash VARCHAR(10),
    weekly_points INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100),
    verification_code VARCHAR(20) UNIQUE
);

CREATE TABLE IF NOT EXISTS verified_students (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, school_id)
);
*/

-- =====================
-- FASE 4: MODERACIÓN + VISITANTE (comentado)
-- =====================

/*
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reason VARCHAR(20) CHECK (reason IN ('threat', 'doxxing', 'spam')),
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS visitors (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    original_zone VARCHAR(10),
    current_zone VARCHAR(10),
    expires_at TIMESTAMP
);
*/
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running migrations...');
    await client.query(SCHEMA);
    console.log('✅ Schema applied successfully');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
