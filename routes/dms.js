const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { sendPush } = require('../services/push');

// GET /dms — lista de conversaciones
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (other_id)
           CASE WHEN dm.from_id = $1 THEN dm.to_id ELSE dm.from_id END AS other_id,
           u2.public_name AS other_name,
           u2.avatar_url  AS other_avatar,
           dm.text        AS last_text,
           dm.created_at  AS last_at,
           (dm.to_id = $1 AND dm.read_at IS NULL) AS unread
         FROM direct_messages dm
         JOIN users u2 ON u2.id = CASE WHEN dm.from_id = $1 THEN dm.to_id ELSE dm.from_id END
         WHERE dm.from_id = $1 OR dm.to_id = $1
         ORDER BY other_id, dm.created_at DESC
       ) conv
       ORDER BY last_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /dms/:userId — mensajes con un usuario concreto
router.get('/:userId', auth, async (req, res) => {
  try {
    // Marcar como leídos
    await pool.query(
      `UPDATE direct_messages SET read_at = NOW()
       WHERE to_id = $1 AND from_id = $2 AND read_at IS NULL`,
      [req.user.id, req.params.userId]
    );

    const result = await pool.query(
      `SELECT dm.id, dm.text, dm.created_at, dm.read_at,
              dm.from_id,
              u.public_name AS from_name, u.avatar_url AS from_avatar
       FROM direct_messages dm
       JOIN users u ON u.id = dm.from_id
       WHERE (dm.from_id = $1 AND dm.to_id = $2)
          OR (dm.from_id = $2 AND dm.to_id = $1)
       ORDER BY dm.created_at ASC
       LIMIT 100`,
      [req.user.id, req.params.userId]
    );

    // Info del otro usuario
    const userInfo = await pool.query(
      `SELECT id, public_name, avatar_url, karma, current_streak FROM users WHERE id = $1`,
      [req.params.userId]
    );

    res.json({ messages: result.rows, other_user: userInfo.rows[0] || null });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /dms/:userId — enviar mensaje
router.post('/:userId', auth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim() || text.trim().length > 1000)
    return res.status(400).json({ error: 'Texto inválido (máx 1000 chars)' });

  try {
    const recipientCheck = await pool.query(
      `SELECT id, public_name, push_token FROM users WHERE id = $1`,
      [req.params.userId]
    );
    if (!recipientCheck.rows.length)
      return res.status(404).json({ error: 'Usuario no encontrado' });

    const recipient = recipientCheck.rows[0];

    const result = await pool.query(
      `INSERT INTO direct_messages (from_id, to_id, text)
       VALUES ($1, $2, $3)
       RETURNING id, text, created_at, from_id`,
      [req.user.id, req.params.userId, text.trim()]
    );

    const msg = result.rows[0];

    // Notificación push al receptor
    if (recipient.push_token) {
      const sender = await pool.query(
        `SELECT public_name FROM users WHERE id = $1`, [req.user.id]
      );
      await sendPush(
        recipient.push_token,
        `💬 ${sender.rows[0]?.public_name || 'Alguien'}`,
        text.trim().slice(0, 80)
      ).catch(() => {});
    }

    res.json({ ok: true, message: msg });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /dms/:messageId — borrar un mensaje propio
router.delete('/:messageId', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM direct_messages WHERE id = $1 AND from_id = $2 RETURNING id`,
      [req.params.messageId, req.user.id]
    );
    if (!r.rows.length) return res.status(403).json({ error: 'No autorizado' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
