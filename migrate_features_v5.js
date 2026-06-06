/**
 * migrate_features_v5.js
 * Migración para: imágenes en posts, stories, modo anónimo,
 * referidos, tienda, clan wars
 */
require('dotenv').config();
const pool = require('./db/pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Imágenes en posts + modo anónimo ──────────────────────────────────
    await client.query(`
      ALTER TABLE posts
        ADD COLUMN IF NOT EXISTS image_url   TEXT,
        ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT false;
    `);

    // ── 2. Stories (24 h) ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
        image_url    TEXT NOT NULL,
        caption      VARCHAR(200),
        geohash_zone VARCHAR(10) NOT NULL,
        created_at   TIMESTAMP DEFAULT NOW(),
        expires_at   TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
      );
      CREATE INDEX IF NOT EXISTS idx_stories_zone_exp
        ON stories(geohash_zone, expires_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS story_views (
        story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
        user_id  UUID REFERENCES users(id)   ON DELETE CASCADE,
        viewed_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (story_id, user_id)
      );
    `);

    // ── 3. Referidos ─────────────────────────────────────────────────────────
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS referral_code VARCHAR(8) UNIQUE;
    `);
    // Generar código para usuarios existentes
    await client.query(`
      UPDATE users
      SET referral_code = UPPER(SUBSTRING(gen_random_uuid()::text, 1, 8))
      WHERE referral_code IS NULL;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id  UUID REFERENCES users(id) ON DELETE CASCADE,
        referred_id  UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        created_at   TIMESTAMP DEFAULT NOW(),
        rewarded     BOOLEAN DEFAULT false
      );
    `);

    // ── 4. Tienda de zona ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        VARCHAR(50) NOT NULL,
        type        VARCHAR(20) NOT NULL,   -- 'frame', 'badge', 'emoji_pack', 'title'
        icon        VARCHAR(10) NOT NULL,
        description TEXT,
        price       INT NOT NULL DEFAULT 100,
        rarity      VARCHAR(10) DEFAULT 'common'  -- common, rare, epic, legendary
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_items (
        user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
        item_id     UUID REFERENCES shop_items(id) ON DELETE CASCADE,
        bought_at   TIMESTAMP DEFAULT NOW(),
        equipped    BOOLEAN DEFAULT false,
        PRIMARY KEY (user_id, item_id)
      );
    `);
    // Items de la tienda (seed)
    await client.query(`
      INSERT INTO shop_items (name, type, icon, description, price, rarity) VALUES
        ('Marco Dorado',     'frame',      '🟡', 'Marco dorado alrededor de tu avatar',         200, 'rare'),
        ('Marco de Fuego',   'frame',      '🔥', 'Tu avatar envuelto en llamas',                500, 'epic'),
        ('Marco Legendario', 'frame',      '👑', 'El marco más exclusivo de la zona',          1000, 'legendary'),
        ('Título: OG',       'title',      '🏅', 'Muestra "OG" bajo tu nombre',                150, 'common'),
        ('Título: Leyenda',  'title',      '⚡', 'Muestra "Leyenda" bajo tu nombre',           300, 'rare'),
        ('Título: El Capo',  'title',      '💎', 'Muestra "El Capo" bajo tu nombre',           800, 'epic'),
        ('Badge Streaker',   'badge',      '🔥', 'Badge especial por racha de 7+ días',        100, 'common'),
        ('Badge Fundador',   'badge',      '🌟', 'Badge exclusivo de primeros usuarios',        50, 'rare'),
        ('Pack Emojis ZAS',  'emoji_pack', '🎉', 'Pack de reacciones especiales',              250, 'rare')
      ON CONFLICT DO NOTHING;
    `);

    // ── 5. Clan Wars ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_wars (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        zone_prefix  VARCHAR(5) NOT NULL,
        week_start   DATE NOT NULL,
        week_end     DATE NOT NULL,
        status       VARCHAR(10) DEFAULT 'active',  -- active, finished
        winner_clan  UUID REFERENCES clans(id) ON DELETE SET NULL,
        created_at   TIMESTAMP DEFAULT NOW(),
        UNIQUE(zone_prefix, week_start)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_war_scores (
        war_id     UUID REFERENCES clan_wars(id) ON DELETE CASCADE,
        clan_id    UUID REFERENCES clans(id)     ON DELETE CASCADE,
        points     INT DEFAULT 0,
        PRIMARY KEY (war_id, clan_id)
      );
    `);
    // Añadir columna war_points a clans para histórico
    await client.query(`
      ALTER TABLE clans
        ADD COLUMN IF NOT EXISTS wars_won INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_war_points INT DEFAULT 0;
    `);

    await client.query('COMMIT');
    console.log('✅ migrate_features_v5: todas las tablas creadas correctamente');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error en migrate_features_v5:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
