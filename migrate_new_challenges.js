require('dotenv').config();
const pool = require('./db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO challenges (name, description, type, metric, goal_value, reward_coins, reward_karma, badge_name) VALUES

      -- ── DIARIOS ──────────────────────────────────────────────────────────────
      ('Cotilla del día',      'Envía 10 mensajes en el chat hoy',          'daily',   'messages_sent',    10,  8,   5,   NULL),
      ('Alma del chat',        'Envía 25 mensajes en el chat hoy',          'daily',   'messages_sent',    25,  20,  10,  NULL),
      ('Demócrata',            'Vota en 2 encuestas hoy',                   'daily',   'polls_voted',      2,   10,  5,   NULL),
      ('Cazatesoros',          'Encuentra 1 tesoro hoy',                    'daily',   'treasures_found',  1,   30,  15,  NULL),

      -- ── SEMANALES ────────────────────────────────────────────────────────────
      ('Charlador semanal',    'Envía 100 mensajes esta semana',            'weekly',  'messages_sent',    100, 60,  20,  NULL),
      ('Escritor semanal',     'Publica 10 posts esta semana',              'weekly',  'posts_created',    10,  50,  15,  NULL),
      ('Pirata novato',        'Esconde 2 tesoros esta semana',             'weekly',  'treasures_hidden', 2,   40,  20,  NULL),
      ('Explorador semanal',   'Encuentra 3 tesoros esta semana',           'weekly',  'treasures_found',  3,   80,  30,  'Explorador'),
      ('Votante activo',       'Vota en 10 encuestas esta semana',          'weekly',  'polls_voted',      10,  40,  15,  NULL),

      -- ── MENSUALES ────────────────────────────────────────────────────────────
      ('Cronista del mes',     'Publica 30 posts este mes',                 'monthly', 'posts_created',    30,  200, 50,  NULL),
      ('Voz del barrio',       'Envía 500 mensajes este mes',               'monthly', 'messages_sent',    500, 300, 75,  'Voz del barrio'),
      ('Gran Explorador',      'Encuentra 10 tesoros este mes',             'monthly', 'treasures_found',  10,  400, 100, 'Gran Explorador'),
      ('Maestro Pirata',       'Esconde 8 tesoros este mes',                'monthly', 'treasures_hidden', 8,   250, 60,  NULL)

      ON CONFLICT (name, type) DO NOTHING;
    `);

    const res = await client.query('SELECT COUNT(*) FROM challenges');
    console.log(`✅ Retos en total: ${res.rows[0].count}`);

    await client.query('COMMIT');
    console.log('✅ Nuevos retos añadidos correctamente');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
