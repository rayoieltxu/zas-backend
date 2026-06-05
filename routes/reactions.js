/**
 * routes/reactions.js — Reacciones emoji en posts
 * POST /reactions/:postId { emoji }  → toggle reacción
 * GET  /reactions/:postId             → obtener conteos
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');

const ALLOWED_EMOJIS = ['🔥', '😂', '💀', '👀', '❤️', '🤯'];

// POST /reactions/:postId
router.post('/:postId', auth, async (req, res) => {
  const { postId } = req.params;
  const { emoji }  = req.body;

  if (!ALLOWED_EMOJIS.includes(emoji))
    return res.status(400).json({ error: 'Emoji no permitido' });

  try {
    // Toggle: si existe la borra, si no la crea
    const existing = await pool.query(
      'SELECT 1 FROM post_reactions WHERE post_id=$1 AND user_id=$2 AND emoji=$3',
      [postId, req.user.id, emoji]
    );

    let action;
    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM post_reactions WHERE post_id=$1 AND user_id=$2 AND emoji=$3',
        [postId, req.user.id, emoji]
      );
      action = 'removed';
    } else {
      await pool.query(
        'INSERT INTO post_reactions (post_id, user_id, emoji) VALUES ($1,$2,$3)',
        [postId, req.user.id, emoji]
      );
      action = 'added';
    }

    // Devolver conteos actualizados
    const counts = await getReactionCounts(postId, req.user.id);
    res.json({ ok: true, action, reactions: counts });
  } catch (err) {
    console.error('Reaction error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /reactions/:postId
router.get('/:postId', auth, async (req, res) => {
  try {
    const counts = await getReactionCounts(req.params.postId, req.user.id);
    res.json({ reactions: counts });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function getReactionCounts(postId, userId) {
  const result = await pool.query(
    `SELECT emoji,
            COUNT(*) AS count,
            BOOL_OR(user_id = $2) AS my_reaction
     FROM post_reactions
     WHERE post_id = $1
     GROUP BY emoji
     ORDER BY count DESC`,
    [postId, userId]
  );
  return result.rows;
}

module.exports = router;
