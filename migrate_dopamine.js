/**
 * migrate_dopamine.js — Sistema de dopamina ZAS
 * Ejecutar: node migrate_dopamine.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {

    // ── 1. Sobre sorpresa diario ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_claims (
        id          SERIAL PRIMARY KEY,
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day         DATE NOT NULL DEFAULT CURRENT_DATE,
        streak      INTEGER NOT NULL DEFAULT 1,
        coins       INTEGER NOT NULL DEFAULT 0,
        item_key    TEXT,
        claimed_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, day)
      )
    `);
    console.log('✅ daily_claims');

    // ── 2. Logros/achievements ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS achievements (
        key         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL,
        icon        TEXT NOT NULL,
        coins       INTEGER DEFAULT 0,
        hidden      BOOLEAN DEFAULT true
      )
    `);

    // Catálogo de logros
    const achvs = [
      ['first_post',       'Primera Voz',        'Publicaste tu primer post en la zona',           '📢', 10,  false],
      ['first_reaction',   'Primer Contacto',     'Reaccionaste a un post por primera vez',         '👋', 5,   false],
      ['streak_3',         'En racha',            'Abriste la app 3 días seguidos',                 '🔥', 15,  false],
      ['streak_7',         'Semana perfecta',     'Abriste la app 7 días seguidos',                 '🔥', 50,  false],
      ['streak_30',        'Mes de fuego',        'Abriste la app 30 días seguidos',                '🔥', 200, false],
      ['top3',             'Élite local',         'Llegaste al Top 3 de tu zona',                   '🏆', 100, false],
      ['top1',             'El rey/reina',        'Fuiste el número 1 de tu zona',                  '👑', 300, false],
      ['first_momento',    'Primer Momento ZAS',  'Subiste tu primera foto en Momento ZAS',         '📸', 20,  false],
      ['momento_7',        'Fotógrafo local',     'Subiste 7 Momentos ZAS',                         '📷', 75,  false],
      ['first_duel',       'Primer duelo',        'Participaste en tu primer duelo',                '⚔️', 25,  true ],
      ['duel_win',         'Ganador nato',        'Ganaste tu primer duelo',                        '🥊', 50,  true ],
      ['duel_win_5',       'Imbatible',           'Ganaste 5 duelos',                               '💪', 150, true ],
      ['early_bird',       'Madrugador',          'Publicaste antes de las 8am',                    '🌅', 20,  true ],
      ['night_owl',        'Noctámbulo',          'Publicaste después de las 12am',                 '🦉', 20,  true ],
      ['combo_x2',         'En llamas',           'Activaste el multiplicador x2 de karma',         '⚡', 30,  true ],
      ['treasure_first',   'Buscador',            'Encontraste tu primer tesoro',                   '💎', 30,  true ],
      ['clan_member',      'En equipo',           'Te uniste a un clan',                            '⚔️', 15,  false],
      ['daily_7',          'Coleccionista',       'Reclamaste el sobre sorpresa 7 días seguidos',   '🎁', 50,  false],
      ['secret_100karma',  'Centurión',           'Acumulaste 100 puntos de karma',                 '💯', 50,  true ],
      ['secret_first_zone','Explorador',          'Visitaste otra zona por primera vez',            '✈️', 40,  true ],
    ];
    for (const [key, name, description, icon, coins, hidden] of achvs) {
      await client.query(
        `INSERT INTO achievements (key,name,description,icon,coins,hidden)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO UPDATE SET name=$2,description=$3,icon=$4,coins=$5,hidden=$6`,
        [key, name, description, icon, coins, hidden]
      );
    }
    console.log('✅ achievements + catálogo');

    // ── 3. Logros de usuario ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id           SERIAL PRIMARY KEY,
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        achievement  TEXT NOT NULL REFERENCES achievements(key),
        unlocked_at  TIMESTAMPTZ DEFAULT NOW(),
        notified     BOOLEAN DEFAULT false,
        UNIQUE(user_id, achievement)
      )
    `);
    console.log('✅ user_achievements');

    // ── 4. Duelos 1v1 ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS duels (
        id                    SERIAL PRIMARY KEY,
        challenger_id         UUID NOT NULL REFERENCES users(id),
        challenged_id         UUID NOT NULL REFERENCES users(id),
        stake_coins           INTEGER DEFAULT 50,
        status                TEXT DEFAULT 'pending',  -- pending|active|completed|rejected|cancelled
        started_at            TIMESTAMPTZ,
        ends_at               TIMESTAMPTZ,
        challenger_karma_start INTEGER,
        challenged_karma_start INTEGER,
        challenger_karma_end   INTEGER,
        challenged_karma_end   INTEGER,
        winner_id             UUID REFERENCES users(id),
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ duels');

    // ── 5. Columnas en user_streaks ────────────────────────────────────────────
    await client.query(`ALTER TABLE user_streaks ADD COLUMN IF NOT EXISTS login_streak   INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE user_streaks ADD COLUMN IF NOT EXISTS last_login     DATE`);
    await client.query(`ALTER TABLE user_streaks ADD COLUMN IF NOT EXISTS combo_multiplier NUMERIC DEFAULT 1.0`);
    await client.query(`ALTER TABLE user_streaks ADD COLUMN IF NOT EXISTS combo_until    TIMESTAMPTZ`);
    console.log('✅ user_streaks columnas');

    // ── 6. Columna zona_en_llamas en users (para caché) ───────────────────────
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1`);
    console.log('✅ users.level');

    console.log('\n🎉 Migración dopamina completada.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
