const express = require('express');
const router  = express.Router({ mergeParams: true }); // para acceder a :postId
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { sendPush } = require('../services/push');

// GET /feed/:postId/comments
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.text, c.created_at,
              u.public_name AS author_name, u.avatar_url AS author_avatar,
              c.user_id,
              (c.user_id = $1) AS is_mine
       FROM post_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.post_id = $2
       ORDER BY c.created_at ASC
       LIMIT 100`,
      [req.user.id, req.params.postId]
    );
    res.json({ comments: result.rows });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// POST /feed/:postId/comments
router.post('/', auth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim() || text.trim().length > 500)
    return res.status(400).json({ error: 'Texto inválido (máx 500 chars)' });
  try {
    const result = await pool.query(
      `INSERT INTO post_comments (post_id, user_id, text)
       VALUES ($1,$2,$3) RETURNING *`,
      [req.params.postId, req.user.id, text.trim()]
    );
    const comment = result.rows[0];

    // Notificar al autor del post
    const postRes = await pool.query('SELECT user_id FROM posts WHERE id=$1', [req.params.postId]);
    const authorId = postRes.rows[0]?.user_id;
    if (authorId && authorId !== req.user.id) {
      sendPush(authorId, {
        title: '💬 Nuevo comentario',
        body: `${req.user.public_name}: "${text.trim().slice(0,60)}"`,
        data: { type: 'comment', post_id: req.params.postId },
      });
    }

    // Detectar @menciones y notificar a cada usuario mencionado
    const mentions = [...text.matchAll(/@(\w+)/g)].map(m => m[1]);
    if (mentions.length > 0) {
      const uniqueMentions = [...new Set(mentions)].slice(0, 5);
      for (const name of uniqueMentions) {
        const mentioned = await pool.query(
          `SELECT id FROM users WHERE public_name ILIKE $1 LIMIT 1`,
          [name]
        );
        const mId = mentioned.rows[0]?.id;
        if (mId && mId !== req.user.id) {
          sendPush(mId, {
            title: `📣 @${req.user.public_name} te mencionó`,
            body: text.trim().slice(0, 80),
            data: { type: 'mention', post_id: req.params.postId },
          });
        }
      }
    }

    res.status(201).json({
      comment: {
        ...comment,
        author_name:   req.user.public_name,
        author_avatar: req.user.avatar_url || null,
        is_mine: true,
      }
    });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /feed/:postId/comments/:commentId
router.delete('/:commentId', auth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM post_comments WHERE id=$1 AND user_id=$2',
      [req.params.commentId, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
