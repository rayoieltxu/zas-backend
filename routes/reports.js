const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');

const VALID_REASONS = ['threat', 'doxxing', 'spam'];
const REASON_LABELS = {
  threat:  'Amenaza real',
  doxxing: 'Datos personales',
  spam:    'Spam',
};

// ─── POST /reports → reportar un post ────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const { post_id, reason } = req.body;

  if (!post_id) return res.status(400).json({ error: 'post_id required' });
  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({ error: 'reason must be: threat, doxxing, spam' });
  }

  try {
    // Obtener el post para saber quién es el autor
    const postResult = await pool.query(
      'SELECT user_id FROM posts WHERE id = $1', [post_id]
    );
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    const reportedUserId = postResult.rows[0].user_id;

    // No puedes reportarte a ti mismo
    if (reportedUserId === req.user.id) {
      return res.status(400).json({ error: 'No puedes reportar tu propio post' });
    }

    await pool.query(
      `INSERT INTO reports (post_id, reporter_id, reported_user_id, reason)
       VALUES ($1, $2, $3, $4)`,
      [post_id, req.user.id, reportedUserId, reason]
    );

    res.json({ ok: true, message: 'Reporte enviado. Un humano lo revisará.' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya has reportado este post' });
    }
    console.error('POST /reports error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /reports/my → mis reportes enviados ────────────────────────────────
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.reason, r.status, r.created_at, p.text AS post_text
       FROM reports r
       LEFT JOIN posts p ON p.id = r.post_id
       WHERE r.reporter_id = $1
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [req.user.id]
    );
    res.json({ reports: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  RUTAS DE ADMIN  (protegidas por X-Admin-Key)
//  En producción usar JWT o token seguro; aquí usamos header simple.
// ═══════════════════════════════════════════════════════════════════
function adminOnly(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// GET /reports/admin → lista de reportes pendientes
router.get('/admin', adminOnly, async (req, res) => {
  const { status = 'pending', limit = 50 } = req.query;
  try {
    const result = await pool.query(
      `SELECT
         r.id, r.reason, r.status, r.created_at, r.admin_note,
         p.id AS post_id, p.text AS post_text, p.geohash_zone,
         rep.public_name AS reporter_name,
         rep_u.public_name AS reported_name
       FROM reports r
       LEFT JOIN posts p ON p.id = r.post_id
       LEFT JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN users rep_u ON rep_u.id = r.reported_user_id
       WHERE r.status = $1
       ORDER BY r.created_at ASC
       LIMIT $2`,
      [status, Math.min(parseInt(limit) || 50, 200)]
    );
    res.json({ reports: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /reports/admin/:id/action → actuar sobre un reporte
// body: { action: 'dismiss' | 'delete_post' | 'ban_user', note?, ban_hours? }
router.post('/admin/:id/action', adminOnly, async (req, res) => {
  const { action, note, ban_hours } = req.body;
  const adminName = req.headers['x-admin-name'] || 'admin';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reportResult = await client.query(
      'SELECT * FROM reports WHERE id = $1', [req.params.id]
    );
    if (reportResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Report not found' });
    }
    const report = reportResult.rows[0];

    // Marcar el reporte como gestionado
    await client.query(
      `UPDATE reports SET status = $1, admin_note = $2, reviewed_at = NOW() WHERE id = $3`,
      [action === 'dismiss' ? 'dismissed' : 'actioned', note || null, report.id]
    );

    // Ejecutar acción
    if (action === 'delete_post' && report.post_id) {
      await client.query('DELETE FROM posts WHERE id = $1', [report.post_id]);

      // Marcar todos los reportes del mismo post como gestionados
      await client.query(
        `UPDATE reports SET status = 'actioned', reviewed_at = NOW() WHERE post_id = $1`,
        [report.post_id]
      );
    }

    if (action === 'ban_user' && report.reported_user_id) {
      const expiresAt = ban_hours
        ? new Date(Date.now() + ban_hours * 3600000)
        : null;

      await client.query(
        `INSERT INTO user_bans (user_id, reason, expires_at, banned_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE
           SET reason = $2, expires_at = $3, banned_at = NOW(), banned_by = $4`,
        [report.reported_user_id, note || report.reason, expiresAt, adminName]
      );
    }

    // Registrar en admin_log
    await client.query(
      `INSERT INTO admin_log (action, target_id, detail, admin_name)
       VALUES ($1, $2, $3, $4)`,
      [action, report.post_id || report.reported_user_id, note, adminName]
    );

    await client.query('COMMIT');
    res.json({ ok: true, action, report_id: report.id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /reports/admin/:id/action error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /reports/admin/ban → banear usuario directamente (sin reporte previo)
router.post('/admin/ban', adminOnly, async (req, res) => {
  const { user_id, reason, ban_hours } = req.body;
  const adminName = req.headers['x-admin-name'] || 'admin';

  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    const expiresAt = ban_hours ? new Date(Date.now() + ban_hours * 3600000) : null;

    await pool.query(
      `INSERT INTO user_bans (user_id, reason, expires_at, banned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET reason = $2, expires_at = $3, banned_at = NOW(), banned_by = $4`,
      [user_id, reason || 'Violación de normas', expiresAt, adminName]
    );
    await pool.query(
      `INSERT INTO admin_log (action, target_id, detail, admin_name) VALUES ('ban_user', $1, $2, $3)`,
      [user_id, reason, adminName]
    );

    res.json({ ok: true, banned_until: expiresAt || 'permanent' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /reports/admin/ban/:userId → levantar baneo
router.delete('/admin/ban/:userId', adminOnly, async (req, res) => {
  const adminName = req.headers['x-admin-name'] || 'admin';
  try {
    await pool.query('DELETE FROM user_bans WHERE user_id = $1', [req.params.userId]);
    await pool.query(
      `INSERT INTO admin_log (action, target_id, admin_name) VALUES ('unban_user', $1, $2)`,
      [req.params.userId, adminName]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /reports/admin/log → log de acciones de admin
router.get('/admin/log', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ log: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
