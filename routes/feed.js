const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { awardCoins, updateStreak, updateChallengeProgress } = require('../services/economy');
const { getChaosState, noChaosDownvote } = require('../services/chaos');

function heatScore(upvotes, downvotes, createdAt) {
  const hours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  return (upvotes * 2) - (downvotes * 0.5) - (hours * 10);
}

// ─── GET /feed ────────────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const { zone, limit = 50 } = req.query;
  const targetZone = zone || req.user.current_geohash;
  const safeLimit  = Math.min(parseInt(limit) || 50, 200);
  const zonePrefix = targetZone.slice(0, 5);

  try {
    const result = await pool.query(
      `SELECT
        p.id, p.text, p.upvotes, p.downvotes, p.created_at, p.geohash_zone, p.is_chaos,
        u.public_name AS author_name, u.karma AS author_karma,
        v.value AS my_vote
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
       WHERE p.geohash_zone LIKE $2
         AND p.created_at > NOW() - INTERVAL '3 days'
         AND p.is_chaos = false
       ORDER BY p.created_at DESC
       LIMIT $3`,
      [req.user.id, `${zonePrefix}%`, safeLimit]
    );

    const sorted = result.rows.sort(
      (a, b) => heatScore(b.upvotes, b.downvotes, b.created_at)
              - heatScore(a.upvotes, a.downvotes, a.created_at)
    );

    const chaos = getChaosState();
    res.json({
      posts: sorted,
      zone: targetZone,
      chaos,
      is_visitor: req.user.is_visitor || false,
      visitor_restrictions: req.user.is_visitor ? ['no_vote', 'no_karma', 'no_treasure'] : [],
    });
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /feed/chaos ──────────────────────────────────────────────────────────
router.get('/chaos', auth, async (req, res) => {
  const chaos = getChaosState();
  if (!chaos.active) return res.status(403).json({ error: 'La Hora del Caos no está activa', chaos });

  const zone   = req.user.current_geohash;
  const prefix = zone.slice(0, 5);
  try {
    const result = await pool.query(
      `SELECT p.id, p.text, p.upvotes, p.created_at,
              u.public_name AS author_name
       FROM posts p LEFT JOIN users u ON p.user_id = u.id
       WHERE p.geohash_zone LIKE $1 AND p.is_chaos = true
         AND p.created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY p.upvotes DESC, p.created_at DESC LIMIT 100`,
      [`${prefix}%`]
    );
    res.json({ posts: result.rows, chaos });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /feed/chaos-status ───────────────────────────────────────────────────
router.get('/chaos-status', auth, (req, res) => {
  res.json({ chaos: getChaosState() });
});

// ─── POST /feed → crear post ──────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length === 0) return res.status(400).json({ error: 'text is required' });
  if (text.length > 500) return res.status(400).json({ error: 'text max 500 chars' });

  const chaos   = getChaosState();
  const isChaos = chaos.active;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Visitantes pueden publicar en el feed (pero no ganan monedas ni karma)
    const result = await client.query(
      `INSERT INTO posts (user_id, text, geohash_zone, is_chaos)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, text.trim(), req.user.current_geohash, isChaos]
    );

    const post = {
      ...result.rows[0],
      author_name:  req.user.public_name,
      author_karma: req.user.karma,
      my_vote:      null,
    };

    await client.query('COMMIT');
    res.status(201).json({ post, chaos, is_visitor: req.user.is_visitor || false });

    // Sin economía para visitantes ni durante el caos
    if (!isChaos && !req.user.is_visitor) {
      try {
        await awardCoins(req.user.id, 'post');
        await updateStreak(req.user.id);
        await updateChallengeProgress(req.user.id, 'posts_created');
      } catch (econErr) {
        console.error('Economy post error:', econErr);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create post error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── POST /feed/vote/:postId ──────────────────────────────────────────────────
router.post('/vote/:postId', auth, noChaosDownvote, async (req, res) => {
  // ── Visitantes NO pueden votar ────────────────────────────────────────────
  if (req.user.is_visitor) {
    return res.status(403).json({
      error: 'Los visitantes no pueden votar. Vuelve a tu zona.',
      code: 'VISITOR_RESTRICTION',
    });
  }

  const { postId } = req.params;
  const { value }  = req.body;
  const chaos      = getChaosState();

  if (value !== 1 && value !== -1) return res.status(400).json({ error: 'value must be 1 or -1' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prevVote = await client.query(
      'SELECT value FROM votes WHERE user_id = $1 AND post_id = $2',
      [req.user.id, postId]
    );

    let upvoteDelta = 0, downvoteDelta = 0, karmaDelta = 0, action = '';
    let isNewUpvote = false;

    if (prevVote.rows.length > 0) {
      const prev = prevVote.rows[0].value;
      if (prev === value) {
        await client.query('DELETE FROM votes WHERE user_id = $1 AND post_id = $2', [req.user.id, postId]);
        if (value === 1) { upvoteDelta = -1; karmaDelta = -2; } else { downvoteDelta = -1; karmaDelta = 0.5; }
        action = 'removed';
      } else {
        await client.query('UPDATE votes SET value = $1, created_at = NOW() WHERE user_id = $2 AND post_id = $3', [value, req.user.id, postId]);
        if (value === 1) { upvoteDelta = 1; downvoteDelta = -1; karmaDelta = 2; isNewUpvote = true; }
        else             { upvoteDelta = -1; downvoteDelta = 1; karmaDelta = -2; }
        action = 'changed';
      }
    } else {
      await client.query('INSERT INTO votes (user_id, post_id, value) VALUES ($1, $2, $3)', [req.user.id, postId, value]);
      if (value === 1) { upvoteDelta = 1; karmaDelta = 2; isNewUpvote = true; } else { downvoteDelta = 1; }
      action = 'added';
    }

    const updatedPost = await client.query(
      `UPDATE posts SET upvotes = upvotes + $1, downvotes = downvotes + $2
       WHERE id = $3 RETURNING id, upvotes, downvotes, user_id`,
      [upvoteDelta, downvoteDelta, postId]
    );

    if (updatedPost.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Post not found' }); }

    if (karmaDelta !== 0 && !chaos.active) {
      await client.query(
        `UPDATE users u SET karma = karma + $1
         FROM posts p WHERE p.id = $2 AND p.user_id = u.id AND p.user_id != $3`,
        [karmaDelta, postId, req.user.id]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, action, post: updatedPost.rows[0], my_vote: action === 'removed' ? null : value, chaos });

    if (isNewUpvote && !chaos.active) {
      const authorId = updatedPost.rows[0].user_id;
      if (authorId && authorId !== req.user.id) {
        try {
          await awardCoins(authorId, 'upvote_received');
          await updateChallengeProgress(authorId, 'upvotes_received');
        } catch (e) { console.error('Economy upvote error:', e); }
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── DELETE /feed/:postId ─────────────────────────────────────────────────────
router.delete('/:postId', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.postId, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Post not found or not yours' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
