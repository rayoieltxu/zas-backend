/**
 * migrate_neon.js
 * Ejecutar UNA SOLA VEZ para crear todo el esquema en Neon.
 * Uso: node migrate_neon.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const NEON_URL = process.env.DATABASE_URL;
if (!NEON_URL) { console.error('❌ DATABASE_URL no definido'); process.exit(1); }

const pool = new Pool({ connectionString: NEON_URL, ssl: { rejectUnauthorized: false } });

const SQL = `

-- ══════════════════════════════════════════════════════
--  TABLAS BASE
-- ══════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id        VARCHAR(255) UNIQUE,
    public_name      VARCHAR(50)  NOT NULL,
    current_geohash  VARCHAR(12),
    radius_km        FLOAT        DEFAULT 5,
    karma            INT          DEFAULT 0,
    level            INT          DEFAULT 1,
    is_under_16      BOOLEAN      DEFAULT false,
    last_active      TIMESTAMP    DEFAULT NOW(),
    created_at       TIMESTAMP    DEFAULT NOW(),
    -- auth
    email            VARCHAR(255) UNIQUE,
    password_hash    VARCHAR(255),
    email_verified   BOOLEAN      DEFAULT false,
    verify_token     VARCHAR(64),
    verify_expires   TIMESTAMP,
    reset_token      VARCHAR(64),
    reset_expires    TIMESTAMP,
    -- extras
    avatar_url       VARCHAR(500),
    school_id        UUID,
    social_links     JSONB        DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_device       ON users(device_id);
CREATE INDEX IF NOT EXISTS idx_users_geohash      ON users(current_geohash);
CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token);
CREATE INDEX IF NOT EXISTS idx_users_reset_token  ON users(reset_token);

CREATE TABLE IF NOT EXISTS posts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    zone         VARCHAR(12)  NOT NULL,
    content      TEXT         NOT NULL,
    upvotes      INT          DEFAULT 0,
    downvotes    INT          DEFAULT 0,
    image_url    VARCHAR(500),
    video_url    VARCHAR(500),
    is_chaos     BOOLEAN      DEFAULT false,
    created_at   TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_posts_zone    ON posts(zone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user    ON posts(user_id);

CREATE TABLE IF NOT EXISTS post_votes (
    user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    post_id  UUID REFERENCES posts(id) ON DELETE CASCADE,
    value    SMALLINT NOT NULL CHECK (value IN (-1, 1)),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    text       VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id);

CREATE TABLE IF NOT EXISTS post_reactions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    emoji      VARCHAR(10) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(post_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_post ON post_reactions(post_id);

CREATE TABLE IF NOT EXISTS reports (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    reason     VARCHAR(100),
    status     VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_post   ON reports(post_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_unique ON reports(post_id, user_id);

CREATE TABLE IF NOT EXISTS direct_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    to_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    text       VARCHAR(1000) NOT NULL,
    read_at    TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dm_participants ON direct_messages(from_id, to_id);
CREATE INDEX IF NOT EXISTS idx_dm_to           ON direct_messages(to_id);

CREATE TABLE IF NOT EXISTS follows (
    follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

CREATE TABLE IF NOT EXISTS push_tokens (
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    token      VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, token)
);

-- ══════════════════════════════════════════════════════
--  MONEDAS, RETOS Y RACHAS
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_coins (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    coins      INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
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

CREATE TABLE IF NOT EXISTS challenges (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    description  TEXT,
    type         VARCHAR(10) CHECK (type IN ('daily','weekly','monthly')),
    metric       VARCHAR(30) NOT NULL,
    goal_value   INT NOT NULL,
    reward_coins INT DEFAULT 0,
    reward_karma INT DEFAULT 0,
    badge_name   VARCHAR(50),
    UNIQUE(name, type)
);

INSERT INTO challenges (name, description, type, metric, goal_value, reward_coins, reward_karma, badge_name) VALUES
  ('Escritor del día',   'Publica 3 posts hoy',               'daily',   'posts_created',    3,  10,  5,   NULL),
  ('Popular del día',    'Consigue 5 upvotes hoy',            'daily',   'upvotes_received', 5,  15,  10,  NULL),
  ('Influencer semanal', 'Consigue 50 upvotes esta semana',   'weekly',  'upvotes_received', 50, 100, 25,  'Popular'),
  ('Leyenda del mes',    'Acumula más karma que 90% tu zona', 'monthly', 'karma_rank',        1,  500, 100, 'Leyenda')
ON CONFLICT (name, type) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_challenges (
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    challenge_id INT REFERENCES challenges(id) ON DELETE CASCADE,
    period_key   VARCHAR(20) NOT NULL,
    progress     INT DEFAULT 0,
    completed    BOOLEAN DEFAULT false,
    claimed      BOOLEAN DEFAULT false,
    PRIMARY KEY (user_id, challenge_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_user_challenges_user ON user_challenges(user_id, period_key);

CREATE TABLE IF NOT EXISTS user_streaks (
    user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak   INT DEFAULT 0,
    longest_streak   INT DEFAULT 0,
    last_active_date DATE
);

-- ══════════════════════════════════════════════════════
--  TESOROS
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS treasures (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    geohash      VARCHAR(10) NOT NULL,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    found_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    hint         TEXT,
    reward_coins INT DEFAULT 50,
    reward_karma INT DEFAULT 10,
    tier         VARCHAR(10) DEFAULT 'common',
    expires_at   TIMESTAMP,
    found_at     TIMESTAMP,
    created_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_treasures_geohash ON treasures(geohash);
CREATE INDEX IF NOT EXISTS idx_treasures_active  ON treasures(found_by, expires_at);

-- ══════════════════════════════════════════════════════
--  ENCUESTAS
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS polls (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    zone_geohash VARCHAR(12) NOT NULL,
    question     TEXT NOT NULL,
    options      JSONB NOT NULL DEFAULT '[]',
    expires_at   TIMESTAMP,
    created_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_polls_zone    ON polls(zone_geohash);
CREATE INDEX IF NOT EXISTS idx_polls_expires ON polls(expires_at);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id    UUID REFERENCES polls(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    option_idx INT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (poll_id, user_id)
);

-- ══════════════════════════════════════════════════════
--  CANALES Y CLANES
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS channels (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_geohash VARCHAR(12) NOT NULL,
    name         VARCHAR(100) NOT NULL,
    description  TEXT,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channels_zone ON channels(zone_geohash);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at  TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);

CREATE TABLE IF NOT EXISTS channel_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    text       TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clans (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_geohash VARCHAR(12) NOT NULL,
    name         VARCHAR(100) NOT NULL UNIQUE,
    description  TEXT,
    leader_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    karma_total  INT DEFAULT 0,
    created_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clans_zone ON clans(zone_geohash);

CREATE TABLE IF NOT EXISTS clan_members (
    clan_id    UUID REFERENCES clans(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    role       VARCHAR(20) DEFAULT 'member',
    joined_at  TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (clan_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_clan_members_user ON clan_members(user_id);

-- ══════════════════════════════════════════════════════
--  VISITORS, STORIES, DOPAMINA
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS visitors (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    zone       VARCHAR(12) NOT NULL,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visitors_expires ON visitors(expires_at);

CREATE TABLE IF NOT EXISTS stories (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    zone       VARCHAR(12) NOT NULL,
    image_url  VARCHAR(500) NOT NULL,
    caption    TEXT,
    expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stories_zone    ON stories(zone, expires_at DESC);

CREATE TABLE IF NOT EXISTS story_views (
    story_id   UUID REFERENCES stories(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    viewed_at  TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (story_id, user_id)
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

CREATE TABLE IF NOT EXISTS duels (
    id             SERIAL PRIMARY KEY,
    challenger_id  UUID NOT NULL REFERENCES users(id),
    challenged_id  UUID NOT NULL REFERENCES users(id),
    stake_coins    INTEGER DEFAULT 50,
    status         TEXT DEFAULT 'pending',
    started_at     TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
    winner_id      UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_duels_users ON duels(challenger_id, challenged_id);

-- ══════════════════════════════════════════════════════
--  MOMENTOS ZAS
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS zas_windows (
    id          SERIAL PRIMARY KEY,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,
    bonus_multiplier FLOAT DEFAULT 2.0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zas_moments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    window_id     INT REFERENCES zas_windows(id) ON DELETE SET NULL,
    zone          VARCHAR(12) NOT NULL,
    image_url     VARCHAR(500) NOT NULL,
    caption       TEXT,
    location_name VARCHAR(200),
    coins_earned  INT DEFAULT 0,
    bonus_earned  INT DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, window_id)
);
CREATE INDEX IF NOT EXISTS idx_zas_moments_zone ON zas_moments(zone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zas_moments_user ON zas_moments(user_id);

-- ══════════════════════════════════════════════════════
--  TIENDA
-- ══════════════════════════════════════════════════════

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
    id         SERIAL PRIMARY KEY,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    item_key   VARCHAR(50) REFERENCES shop_items(key),
    quantity   INT DEFAULT 1,
    equipped   BOOLEAN DEFAULT false,
    bought_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, item_key)
);

-- ══════════════════════════════════════════════════════
--  GUERRAS DE CLANES
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clan_wars (
    id          SERIAL PRIMARY KEY,
    zone        VARCHAR(12) NOT NULL,
    week_start  DATE NOT NULL,
    week_end    DATE NOT NULL,
    winner_clan UUID REFERENCES clans(id),
    prize_coins INT DEFAULT 100,
    prize_karma INT DEFAULT 50,
    status      VARCHAR(20) DEFAULT 'active',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(zone, week_start)
);

-- ══════════════════════════════════════════════════════
--  MENSUAL TOP
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS monthly_top (
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    period_key VARCHAR(7) NOT NULL,
    zone       VARCHAR(12),
    score      INT DEFAULT 0,
    rank       INT,
    PRIMARY KEY (user_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_monthly_top_user ON monthly_top(user_id, period_key);

-- ══════════════════════════════════════════════════════
--  ÍNDICES ADICIONALES
-- ══════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_image      ON posts(zone) WHERE image_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_karma      ON users(current_geohash, karma DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active DESC);

`;

async function main() {
  const client = await pool.connect();
  try {
    console.log('🔗 Conectando a Neon...');
    await client.query('SELECT 1');
    console.log('✅ Conexión OK');
    console.log('🚀 Aplicando esquema completo...');
    await client.query(SQL);
    console.log('✅ Esquema aplicado correctamente en Neon');

    // Verificar tablas creadas
    const { rows } = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    console.log('\n📋 Tablas creadas:', rows.map(r => r.tablename).join(', '));
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
