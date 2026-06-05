/**
 * socket.js (BACKEND) — reemplaza el actual backend/socket.js
 * Gestiona conexiones, mensajes de chat, ubicación y notificaciones de votos
 */
const pool = require('./db/pool');

// Mapa: userId → Set de socket IDs
const userSockets = new Map();

module.exports = function setupSocket(io) {

  io.on('connection', async (socket) => {
    const deviceId = socket.handshake.auth?.device_id;
    let userId     = null;

    // ── Autenticar por device_id ──────────────────────────────────────────────
    if (deviceId) {
      try {
        const result = await pool.query(
          'SELECT id FROM users WHERE device_id = $1', [deviceId]
        );
        if (result.rows.length > 0) {
          userId = result.rows[0].id;
          if (!userSockets.has(userId)) userSockets.set(userId, new Set());
          userSockets.get(userId).add(socket.id);
          console.log(`🔌 Socket connected: ${deviceId} (user: ${userId})`);
        }
      } catch (err) {
        console.error('Socket auth error:', err);
      }
    }

    // ── Unirse a zona ─────────────────────────────────────────────────────────
    socket.on('update_location', ({ geohash }) => {
      // Salir de zonas anteriores
      socket.rooms.forEach(room => {
        if (room !== socket.id && room.startsWith('zone:')) {
          socket.leave(room);
        }
      });
      if (geohash) {
        const zone = `zone:${geohash.slice(0, 5)}`;
        socket.join(zone);
      }
    });

    // ── Mensajes de chat ──────────────────────────────────────────────────────
    socket.on('send_message', async ({ text, zone_id }) => {
      if (!userId || !text?.trim() || !zone_id) return;
      try {
        const result = await pool.query(
          `INSERT INTO chat_messages (zone_id, user_id, text)
           VALUES ($1, $2, $3) RETURNING id, created_at`,
          [zone_id, userId, text.trim().slice(0, 500)]
        );
        const userRow = await pool.query(
          'SELECT public_name, avatar_url FROM users WHERE id = $1', [userId]
        );
        const msg = {
          id:            result.rows[0].id,
          text:          text.trim(),
          zone_id,
          user_id:       userId,
          author_name:   userRow.rows[0]?.public_name || 'Anónimo',
          author_avatar: userRow.rows[0]?.avatar_url  || null,
          created_at:    result.rows[0].created_at,
        };
        io.to(`zone:${zone_id.slice(0, 5)}`).emit('new_message', msg);

        // Monedas + retos por mensaje
        try {
          const { awardCoins, updateChallengeProgress } = require('./services/economy');
          const earned = await awardCoins(userId, 'message');
          if (earned > 0) emitToUser(io, userSockets, userId, 'coins_earned', { amount: earned, reason: 'message' });
          await updateChallengeProgress(userId, 'messages_sent');
        } catch {}
      } catch (err) {
        console.error('Send message error:', err);
      }
    });

    // ── Desconexión ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (userId && userSockets.has(userId)) {
        userSockets.get(userId).delete(socket.id);
        if (userSockets.get(userId).size === 0) userSockets.delete(userId);
      }
      console.log(`🔌 Socket disconnected: ${deviceId || socket.id}`);
    });
  });

  // Exponer función para notificar a un usuario desde routes
  io.notifyUser = (userId, event, data) => emitToUser(io, userSockets, userId, event, data);
};

function emitToUser(io, userSockets, userId, event, data) {
  const sockets = userSockets.get(userId);
  if (sockets && sockets.size > 0) {
    sockets.forEach(socketId => {
      io.to(socketId).emit(event, data);
    });
  }
}
