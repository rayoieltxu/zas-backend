const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { getChallengesForUser, getPeriodKey } = require('../services/economy');

// GET /challenges → lista de retos con progreso actual del usuario
router.get('/', auth, async (req, res) => {
  try {
    const challenges = await getChallengesForUser(req.user.id);
    res.json({ challenges });
  } catch (err) {
    console.error('GET /challenges error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /challenges/:id/claim → reclamar recompensa de reto completado
router.post('/:id/claim', auth, async (req, res) => {
  const { id } = req.params;
  const now = new Date();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener el reto
    const chResult = await client.query(
      'SELECT * FROM challenges WHERE id = $1',
      [id]
    );
    if (chResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Challenge not found' });
    }
    const ch = chResult.rows[0];
    const periodKey = getPeriodKey(ch.type, now);

    // Obtener progreso del usuario
    const ucResult = await client.query(
      `SELECT * FROM user_challenges
       WHERE user_id = $1 AND challenge_id = $2 AND period_key = $3`,
      [req.user.id, id, periodKey]
    );

    if (ucResult.rows.length === 0 || !ucResult.rows[0].completed) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Challenge not completed yet' });
    }

    if (ucResult.rows[0].claimed) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already claimed' });
    }

    // Marcar como reclamado
    await client.query(
      `UPDATE user_challenges SET claimed = true
       WHERE user_id = $1 AND challenge_id = $2 AND period_key = $3`,
      [req.user.id, id, periodKey]
    );

    // Las recompensas se otorgaron al completar (en updateChallengeProgress)
    // Aquí solo confirmamos el claim y devolvemos los datos

    await client.query('COMMIT');

    res.json({
      ok: true,
      challenge_name: ch.name,
      reward_coins: ch.reward_coins,
      reward_karma: ch.reward_karma,
      badge_name: ch.badge_name,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /challenges/:id/claim error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /challenges/streak → racha del usuario
router.get('/streak', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_streaks WHERE user_id = $1',
      [req.user.id]
    );
    const streak = result.rows[0] || {
      current_streak: 0,
      longest_streak: 0,
      last_active_date: null,
    };
    res.json({ streak });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
