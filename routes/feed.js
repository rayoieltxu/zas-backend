/**
 * routes/feed.js — reemplaza el actual backend/routes/feed.js
 * Añade notificación socket al autor cuando recibe upvote
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { awardCoins, updateStreak, updateChallengeProgress } = require('../services/economy');
const { getChaosState, noChaosDownvote } = require('../services/chaos');
const { sendPush } = require('../services/push');
const { awardWarPoints } = require('./wars');

function heatScore(upvotes, downvotes, createdAt) {
  const hours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  return (upvotes * 2) - (downvotes * 0.5) - (hours * 10);
}

// ─── GET /feed ────────────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const { zone, limit = 30, offset = 0, image_only, video_only } = req.query;
  const targetZone  = zone || req.user.current_geohash;
  const safeLimit   = Math.min(parseInt(limit)  || 30, 100);
  const safeOffset  = Math.max(parseInt(offset) || 0,  0);
  const zonePrefix  = targetZone.slice(0, 5);

  try {
    const result = await pool.query(
      `SELECT
        p.id, p.text, p.image_url, p.video_url, p.video_thumbnail, p.is_anonymous, p.upvotes, p.downvotes,
        p.created_at, p.geohash_zone, p.is_chaos,
        CASE WHEN p.is_anonymous THEN NULL ELSE p.user_id END AS author_id,
        CASE WHEN p.is_anonymous THEN 'Anónimo' ELSE u.public_name END AS author_name,
        CASE WHEN p.is_anonymous THEN NULL ELSE u.karma END AS author_karma,
        CASE WHEN p.is_anonymous THEN NULL ELSE u.avatar_url END AS author_avatar,
        CASE WHEN p.is_anonymous THEN NULL ELSE
          (SELECT json_build_object('icon', si.icon, 'rarity', si.rarity, 'name', si.name)
           FROM user_items ui JOIN shop_items si ON si.id = ui.item_id
           WHERE ui.user_id = p.user_id AND ui.equipped = true AND si.type = 'frame' LIMIT 1)
        END AS author_frame,
        CASE WHEN p.is_anonymous THEN NULL ELSE
          (SELECT json_build_object('icon', si.icon, 'rarity', si.rarity, 'name', si.name)
           FROM user_items ui JOIN shop_items si ON si.id = ui.item_id
           WHERE ui.user_id = p.user_id AND ui.equipped = true AND si.type = 'badge' LIMIT 1)
        END AS author_badge,
        CASE WHEN p.is_anonymous THEN NULL ELSE
          (SELECT json_build_object('icon', si.icon, 'name', si.name)
           FROM user_items ui JOIN shop_items si ON si.id = ui.item_id
           WHERE ui.user_id = p.user_id AND ui.equipped = true AND si.type = 'title' LIMIT 1)
        END AS author_title,
        v.value AS my_vote,
        (SELECT COUNT(*)::int FROM post_comments WHERE post_id = p.id) AS comments_count,
        COALESCE(
          json_agg(
            json_build_object('emoji', pr.emoji, 'count', pr.cnt, 'my_reaction', pr.mine)
          ) FILTER (WHERE pr.emoji IS NOT NULL),
          '[]'
        ) AS reactions
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
       LEFT JOIN (
         SELECT post_id, emoji,
           COUNT(*)::int AS cnt,
           BOOL_OR(user_id = $1) AS mine
         FROM post_reactions
         GROUP BY post_id, emoji
       ) pr ON pr.post_id = p.id
       WHERE p.geohash_zone LIKE $2
         AND p.created_at > NOW() - INTERVAL '3 days'
         AND p.is_chaos = false
         ${image_only === 'true' ? 'AND p.image_url IS NOT NULL' : ''}
         ${video_only === 'true'
           ? 'AND p.video_url IS NOT NULL'
           : 'AND p.video_url IS NULL'}
       GROUP BY p.id, u.public_name, u.karma, u.avatar_url, v.value, p.user_id
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, `${zonePrefix}%`, safeLimit, safeOffset]
    );

    const sorted = result.rows.sort(
      (a, b) => heatScore(b.upvotes, b.downvotes, b.created_at)
              - heatScore(a.upvotes, a.downvotes, a.created_at)
    );

    const chaos = getChaosState();
    res.json({
      posts: sorted,
      has_more: result.rows.length === safeLimit,
      offset: safeOffset,
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

  const zonePrefix = req.user.current_geohash.slice(0, 5);
  try {
    const result = await pool.query(
      `SELECT p.id, p.text, p.image_url, p.is_anonymous, p.upvotes, p.created_at,
              CASE WHEN p.is_anonymous THEN 'Anónimo' ELSE u.public_name END AS author_name,
              CASE WHEN p.is_anonymous THEN NULL ELSE u.avatar_url END AS author_avatar
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.geohash_zone LIKE $1 AND p.is_chaos = true
       ORDER BY p.upvotes DESC LIMIT 50`,
      [`${zonePrefix}%`]
    );
    res.json({ posts: result.rows, chaos });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /feed ───────────────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const { text, image_url, video_url, video_thumbnail, is_anonymous = false } = req.body;
  if (!text?.trim() && !image_url && !video_url) return res.status(400).json({ error: 'text, image o video requerido' });
  if (text && text.trim().length > 500) return res.status(400).json({ error: 'Max 500 chars' });
  if (req.user.is_visitor) return res.status(403).json({ error: 'Visitantes no pueden publicar', code: 'VISITOR_RESTRICTION' });

  const chaos   = getChaosState();
  const isChaos = chaos.active;
  const client  = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO posts (user_id, text, image_url, video_url, video_thumbnail, is_anonymous, geohash_zone, is_chaos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.id, text?.trim() || '', image_url || null, video_url || null, video_thumbnail || null,
       Boolean(is_anonymous), req.user.current_geohash, isChaos]
    );
    const post = {
      ...result.rows[0],
      author_name:   is_anonymous ? 'Anónimo' : req.user.public_name,
      author_karma:  is_anonymous ? null : req.user.karma,
      author_avatar: is_anonymous ? null : (req.user.avatar_url || null),
      my_vote: null,
    };
    await client.query('COMMIT');
    res.status(201).json({ post, chaos, is_visitor: false });

    // Emitir post en tiempo real a todos en la zona
    const io = req.app.get('io');
    if (io) {
      const zoneRoom = `zone:${req.user.current_geohash.slice(0, 5)}`;
      io.to(zoneRoom).emit('new_post', { post: { ...post, reactions: [] } });
    }

    if (!isChaos) {
      try {
        const earned = await awardCoins(req.user.id, 'post');
        await updateStreak(req.user.id);
        await updateChallengeProgress(req.user.id, 'posts_created');
        awardWarPoints(req.user.id, 5).catch(() => {}); // post = 5 pts guerra
        if (earned > 0 && io?.notifyUser) {
          io.notifyUser(req.user.id, 'coins_earned', { amount: earned, reason: 'post' });
        }
      } catch (e) { console.error('Economy post error:', e); }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create post error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

// ─── POST /feed/vote/:postId ──────────────────────────────────────────────────
router.post('/vote/:postId', auth, noChaosDownvote, async (req, res) => {
  if (req.user.is_visitor)
    return res.status(403).json({ error: 'Los visitantes no pueden votar.', code: 'VISITOR_RESTRICTION' });

  const { postId } = req.params;
  const { value }  = req.body;
  const chaos      = getChaosState();

  if (value !== 1 && value !== -1) return res.status(400).json({ error: 'value must be 1 or -1' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prevVote = await client.query(
      'SELECT value FROM votes WHERE user_id=$1 AND post_id=$2',
      [req.user.id, postId]
    );

    let upvoteDelta = 0, downvoteDelta = 0, karmaDelta = 0, action = '', isNewUpvote = false;

    if (prevVote.rows.length > 0) {
      const prev = prevVote.rows[0].value;
      if (prev === value) {
        await client.query('DELETE FROM votes WHERE user_id=$1 AND post_id=$2', [req.user.id, postId]);
        if (value === 1) { upvoteDelta = -1; karmaDelta = -2; } else { downvoteDelta = -1; karmaDelta = 0.5; }
        action = 'removed';
      } else {
        await client.query('UPDATE votes SET value=$1, created_at=NOW() WHERE user_id=$2 AND post_id=$3', [value, req.user.id, postId]);
        if (value === 1) { upvoteDelta = 1; downvoteDelta = -1; karmaDelta = 2; isNewUpvote = true; }
        else             { upvoteDelta = -1; downvoteDelta = 1; karmaDelta = -2; }
        action = 'changed';
      }
    } else {
      await client.query('INSERT INTO votes (user_id,post_id,value) VALUES ($1,$2,$3)', [req.user.id, postId, value]);
      if (value === 1) { upvoteDelta = 1; karmaDelta = 2; isNewUpvote = true; } else { downvoteDelta = 1; }
      action = 'added';
    }

    const updatedPost = await client.query(
      `UPDATE posts SET upvotes=upvotes+$1, downvotes=downvotes+$2
       WHERE id=$3 RETURNING id, upvotes, downvotes, user_id`,
      [upvoteDelta, downvoteDelta, postId]
    );

    if (updatedPost.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Post not found' });
    }

    if (karmaDelta !== 0 && !chaos.active) {
      await client.query(
        `UPDATE users u SET karma=karma+$1
         FROM posts p WHERE p.id=$2 AND p.user_id=u.id AND p.user_id!=$3`,
        [karmaDelta, postId, req.user.id]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, action, post: updatedPost.rows[0], my_vote: action === 'removed' ? null : value, chaos });

    // Notificar al autor via socket si recibe upvote
    if (isNewUpvote && !chaos.active) {
      const authorId = updatedPost.rows[0].user_id;
      if (authorId && authorId !== req.user.id) {
        try {
          const earned = await awardCoins(authorId, 'upvote_received');
          await updateChallengeProgress(authorId, 'upvotes_received');
          awardWarPoints(authorId, 2).catch(() => {}); // upvote recibido = 2 pts guerra
          if (earned > 0 && req.app?.get('io')?.notifyUser) {
            req.app.get('io').notifyUser(authorId, 'coins_earned', { amount: earned, reason: 'upvote_received' });
          }
          if (req.app?.get('io')?.notifyUser) {
            req.app.get('io').notifyUser(authorId, 'vote_received', { post_id: postId, voter: req.user.public_name });
          }
          // Push notification
          if (value === 1) {
            sendPush(authorId, {
              title: '⬆️ Nuevo upvote',
              body:  `${req.user.public_name || 'Alguien'} votó tu post`,
              data:  { type: 'upvote', post_id: postId },
            });
          }
        } catch (e) { console.error('Economy upvote error:', e); }
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

// ─── DELETE /feed/:postId ─────────────────────────────────────────────────────
router.delete('/:postId', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM posts WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.postId, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Post not found or not yours' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
