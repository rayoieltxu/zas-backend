require('dotenv').config();
const pool = require('./db/pool');

const FASE3_SCHEMA = `

CREATE TABLE IF NOT EXISTS channels (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(50)  NOT NULL,
    description  TEXT,
    owner_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    zone_geohash VARCHAR(10)  NOT NULL,
    created_at   TIMESTAMP DEFAULT NOW(),
    last_active  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channels_zone ON channels(zone_geohash);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id   UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id      UUID REFERENCES users(id)    ON DELETE CASCADE,
    is_moderator BOOLEAN DEFAULT false,
    joined_at    TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id)    ON DELETE SET NULL,
    text       VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clans (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(30) NOT NULL,
    tag           VARCHAR(6)  NOT NULL,
    description   TEXT,
    leader_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    zone_geohash  VARCHAR(10) NOT NULL,
    weekly_points INT DEFAULT 0,
    created_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clans_zone ON clans(zone_geohash);

CREATE TABLE IF NOT EXISTS clan_members (
    clan_id   UUID REFERENCES clans(id) ON DELETE CASCADE,
    user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (clan_id, user_id)
);

CREATE TABLE IF NOT EXISTS schools (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(100) NOT NULL,
    zone_geohash      VARCHAR(10),
    verification_code VARCHAR(20) UNIQUE NOT NULL,
    created_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verified_students (
    user_id     UUID REFERENCES users(id)   ON DELETE CASCADE,
    school_id   UUID REFERENCES schools(id) ON DELETE CASCADE,
    verified_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, school_id)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS monthly_top (
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    zone_geohash VARCHAR(10) NOT NULL,
    period_key   VARCHAR(7)  NOT NULL,
    rank         SMALLINT    NOT NULL,
    score        INT         NOT NULL,
    social_links JSONB       DEFAULT '{}',
    created_at   TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY  (zone_geohash, period_key, rank)
);
CREATE INDEX IF NOT EXISTS idx_monthly_top_user ON monthly_top(user_id, period_key);

CREATE INDEX IF NOT EXISTS idx_clan_members_user    ON clan_members(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running Fase 3 migration...');
    await client.query(FASE3_SCHEMA);
    console.log('Fase 3 schema applied');
  } catch (err) {
    console.error('Fase 3 migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
