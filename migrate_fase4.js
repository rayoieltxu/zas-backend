require('dotenv').config();
const pool = require('./db/pool');

const FASE4_SCHEMA = `

-- ── Reportes ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id     UUID REFERENCES posts(id)  ON DELETE CASCADE,
    reporter_id UUID REFERENCES users(id)  ON DELETE SET NULL,
    reported_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reason      VARCHAR(20) CHECK (reason IN ('threat','doxxing','spam')),
    status      VARCHAR(20) DEFAULT 'pending'
                CHECK (status IN ('pending','reviewed','dismissed','actioned')),
    admin_note  TEXT,
    created_at  TIMESTAMP DEFAULT NOW(),
    reviewed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_post   ON reports(post_id);

-- Evitar spam de reportes: un usuario solo puede reportar el mismo post una vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_unique
    ON reports(reporter_id, post_id) WHERE status != 'dismissed';

-- ── Baneos de usuario (manual por admin) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_bans (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason     TEXT,
    banned_at  TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,          -- NULL = permanente
    banned_by  VARCHAR(50)         -- nombre del admin
);

-- ── Visitantes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visitors (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    original_zone VARCHAR(10) NOT NULL,
    current_zone  VARCHAR(10) NOT NULL,
    expires_at    TIMESTAMP   NOT NULL
);

-- ── Log de acciones de admin ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_log (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action     VARCHAR(50)  NOT NULL,
    target_id  UUID,
    detail     TEXT,
    admin_name VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_visitors_expires ON visitors(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_log_created ON admin_log(created_at DESC);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running Fase 4 migration...');
    await client.query(FASE4_SCHEMA);
    console.log('✅ Fase 4 schema applied');
  } catch (err) {
    console.error('❌ Fase 4 migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
