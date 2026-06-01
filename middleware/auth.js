const pool = require('../db/pool');

/**
 * Middleware de autenticación Fase 4
 * - Autentica por device_id
 * - Verifica si el usuario tiene baneo activo
 * - Enriquece req.user con estado de visitante si aplica
 */
async function authMiddleware(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) {
    return res.status(401).json({ error: 'Missing X-Device-Id header' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE device_id = $1',
      [deviceId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not registered', code: 'NOT_REGISTERED' });
    }

    const user = result.rows[0];

    // ── Comprobar baneo activo ────────────────────────────────────────────────
    const banResult = await pool.query(
      `SELECT * FROM user_bans
       WHERE user_id = $1
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [user.id]
    );

    if (banResult.rows.length > 0) {
      const ban = banResult.rows[0];
      return res.status(403).json({
        error: 'Tu cuenta ha sido suspendida',
        code: 'BANNED',
        reason: ban.reason || 'Violación de normas comunitarias',
        expires_at: ban.expires_at || null,
      });
    }

    // ── Enriquecer con estado de visitante ────────────────────────────────────
    const visitorResult = await pool.query(
      `SELECT * FROM visitors
       WHERE user_id = $1 AND expires_at > NOW()`,
      [user.id]
    );

    if (visitorResult.rows.length > 0) {
      const v = visitorResult.rows[0];
      user.is_visitor     = true;
      user.visitor_zone   = v.current_zone;
      user.original_zone  = v.original_zone;
      user.visitor_expires = v.expires_at;
      // Mientras es visitante, su zona efectiva es la de destino
      user.current_geohash = v.current_zone;
    } else {
      user.is_visitor = false;
      // Limpiar registros de visita expirados
      pool.query('DELETE FROM visitors WHERE user_id = $1 AND expires_at <= NOW()', [user.id])
        .catch(() => {});
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = authMiddleware;
