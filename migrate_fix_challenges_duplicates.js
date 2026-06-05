require('dotenv').config();
const pool = require('./db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ver cuántos duplicados hay
    const dupCheck = await client.query(`
      SELECT name, type, COUNT(*) as cnt
      FROM challenges
      GROUP BY name, type
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
    `);
    console.log(`Grupos con duplicados: ${dupCheck.rows.length}`);
    dupCheck.rows.forEach(r => console.log(`  "${r.name}" (${r.type}) → ${r.cnt} copias`));

    // 2. Para cada grupo de duplicados, quedarnos solo con el ID más antiguo
    //    y redirigir todas las referencias de user_challenges al que sobrevive
    const groups = await client.query(`
      SELECT name, type, MIN(id) AS keep_id, array_agg(id) AS all_ids
      FROM challenges
      GROUP BY name, type
      HAVING COUNT(*) > 1
    `);

    for (const row of groups.rows) {
      const keepId  = row.keep_id;
      const dropIds = row.all_ids.filter(id => id !== keepId).map(Number);

      // Redirigir user_challenges al ID que sobrevive (ignorar conflictos)
      for (const dropId of dropIds) {
        await client.query(`
          UPDATE user_challenges
          SET challenge_id = $1
          WHERE challenge_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM user_challenges uc2
              WHERE uc2.challenge_id = $1
                AND uc2.user_id     = user_challenges.user_id
                AND uc2.period_key  = user_challenges.period_key
            )
        `, [keepId, dropId]);

        // Borrar los que no se pudieron redirigir (conflicto de clave)
        await client.query(`
          DELETE FROM user_challenges WHERE challenge_id = $1
        `, [dropId]);
      }

      // Borrar los challenges duplicados
      await client.query(`
        DELETE FROM challenges WHERE id = ANY($1::int[])
      `, [dropIds]);

      console.log(`✅ "${row.name}" (${row.type}): eliminadas ${dropIds.length} copias`);
    }

    // 3. Añadir restricción UNIQUE (name, type) para que no vuelva a pasar
    await client.query(`
      ALTER TABLE challenges
      ADD CONSTRAINT challenges_name_type_unique UNIQUE (name, type);
    `).catch(err => {
      // Si ya existe, ignorar
      if (err.code === '42710') console.log('Restricción UNIQUE ya existía');
      else throw err;
    });

    await client.query('COMMIT');
    console.log('✅ Migración completada — retos deduplicados y protegidos');
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
