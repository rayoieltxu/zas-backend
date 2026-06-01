require('dotenv').config();
const pool = require('./db/pool');

const FASE2_SCHEMA = `

-- ── Tesoros ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treasures (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    geohash      VARCHAR(10) NOT NULL,
    hint         TEXT NOT NULL,
    reward_coins INT  DEFAULT 25,
    reward_karma INT  DEFAULT 10,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    found_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMP DEFAULT NOW(),
    found_at     TIMESTAMP,
    expires_at   TIMESTAMP DEFAULT NOW() + INTERVAL '7 days'
);
CREATE INDEX IF NOT EXISTS idx_treasures_geohash ON treasures(geohash);
CREATE INDEX IF NOT EXISTS idx_treasures_active  ON treasures(found_by, expires_at);

-- ── Encuestas (Termómetro) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS polls (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question     VARCHAR(200) NOT NULL,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMP DEFAULT NOW(),
    expires_at   TIMESTAMP NOT NULL,
    zone_geohash VARCHAR(10) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_zone    ON polls(zone_geohash);
CREATE INDEX IF NOT EXISTS idx_polls_expires ON polls(expires_at);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id  UUID REFERENCES polls(id) ON DELETE CASCADE,
    user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    vote     BOOLEAN NOT NULL,   -- true = Sí, false = No
    voted_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (poll_id, user_id)
);

-- ── Historial de Horas del Caos (para auditoría) ──────────────────────────────
-- No hace falta tabla: se calcula en tiempo real con lógica horaria.
-- Sí guardamos una flag en posts para saber si fueron publicados durante el caos.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_chaos BOOLEAN DEFAULT false;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running Fase 2 migration...');
    await client.query(FASE2_SCHEMA);
    console.log('✅ Fase 2 schema applied');
  } catch (err) {
    console.error('❌ Fase 2 migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
