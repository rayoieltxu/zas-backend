const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { spendCoins } = require('../services/economy');

// ─── GET /polls?zone=geohash ──────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const zone   = req.query.zone || req.user.current_geohash;
  const prefix = zone.slice(0, 5);

  try {
    const result = await pool.query(
      `SELECT
         p.id, p.question, p.created_at, p.expires_at, p.zone_geohash,
         u.public_name          AS created_by_name,
         (p.created_by = $1)    AS is_mine,
         COUNT(pv.poll_id)      AS total_votes,
         COUNT(CASE WHEN pv.vote = true  THEN 1 END) AS yes_votes,
         COUNT(CASE WHEN pv.vote = false THEN 1 END) AS no_votes,
         MAX(CASE WHEN pv.user_id = $1 THEN pv.vote::int ELSE -1 END) AS my_vote_raw
       FROM polls p
       LEFT JOIN users u  ON u.id = p.created_by
       LEFT JOIN poll_votes pv ON pv.poll_id = p.id
       WHERE p.zone_geohash LIKE $2
         AND p.expires_at > NOW()
       GROUP BY p.id, u.public_name
       ORDER BY p.created_at DESC
       LIMIT 30`,
      [req.user.id, `${prefix}%`]
    );

    const polls = result.rows.map(r => ({
      ...r,
      total_votes: parseInt(r.total_votes),
      yes_votes:   parseInt(r.yes_votes),
      no_votes:    parseInt(r.no_votes),
      my_vote:     r.my_vote_raw === -1 ? null : Boolean(r.my_vote_raw),
      yes_pct: parseInt(r.total_votes) > 0
        ? Math.round((parseInt(r.yes_votes) / parseInt(r.total_votes)) * 100)
        : 0,
    }));

    res.json({ polls });
  } catch (err) {
    console.error('GET /polls error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /polls → crear encuesta (cuesta 30 monedas) ────────────────────────
router.post('/', auth, async (req, res) => {
  const { question } = req.body;

  if (!question || question.trim().length < 10) {
    return res.status(400).json({ error: 'question must be at least 10 characters' });
  }
  if (question.length > 200) {
    return res.status(400).json({ error: 'question max 200 chars' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await spendCoins(req.user.id, 'create_poll', client);

    const result = await client.query(
      `INSERT INTO polls (question, created_by, expires_at, zone_geohash)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours', $3)
       RETURNING *`,
      [question.trim(), req.user.id, req.user.current_geohash]
    );

    await client.query('COMMIT');
    res.status(201).json({ poll: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message === 'INSUFFICIENT_COINS') {
      return res.status(402).json({ error: 'Necesitas 30 monedas para crear una encuesta' });
    }
    console.error('POST /polls error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── POST /polls/:id/vote → votar ─────────────────────────────────────────────
router.post('/:id/vote', auth, async (req, res) => {
  const { vote } = req.body; // true = Sí, false = No

  if (typeof vote !== 'boolean') {
    return res.status(400).json({ error: 'vote must be true or false' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que la encuesta existe y no ha expirado
    const pollRes = await client.query(
      'SELECT * FROM polls WHERE id = $1 AND expires_at > NOW()',
      [req.params.id]
    );
    if (pollRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Poll not found or expired' });
    }

    // Upsert voto (permite cambiar de opinión)
    await client.query(
      `INSERT INTO poll_votes (poll_id, user_id, vote)
       VALUES ($1, $2, $3)
       ON CONFLICT (poll_id, user_id) DO UPDATE SET vote = $3, voted_at = NOW()`,
      [req.params.id, req.user.id, vote]
    );

    // Devolver resultados actualizados
    const statsRes = await client.query(
      `SELECT
         COUNT(*)                                      AS total_votes,
         COUNT(CASE WHEN vote = true  THEN 1 END)      AS yes_votes,
         COUNT(CASE WHEN vote = false THEN 1 END)      AS no_votes
       FROM poll_votes WHERE poll_id = $1`,
      [req.params.id]
    );
    const stats = statsRes.rows[0];
    const total = parseInt(stats.total_votes);

    await client.query('COMMIT');

    res.json({
      ok: true,
      my_vote: vote,
      total_votes: total,
      yes_votes:   parseInt(stats.yes_votes),
      no_votes:    parseInt(stats.no_votes),
      yes_pct:     total > 0 ? Math.round((parseInt(stats.yes_votes) / total) * 100) : 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /polls/:id/vote error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
