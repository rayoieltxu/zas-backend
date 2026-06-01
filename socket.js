const pool = require('./db/pool');

/**
 * Configura Socket.io para el backend de Zas
 * Maneja: autenticación, chat de zona, actualizaciones de monedas
 */
function setupSocket(io) {
  // Middleware de autenticación para sockets
  io.use(async (socket, next) => {
    const deviceId = socket.handshake.auth?.device_id;
    if (!deviceId) return next(new Error('Missing device_id'));

    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE device_id = $1',
        [deviceId]
      );
      if (result.rows.length === 0) return next(new Error('User not registered'));
      socket.user = result.rows[0];
      next();
    } catch (err) {
      next(new Error('Auth error'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.user?.public_name}`);

    // Unirse a zona automáticamente
    const zone = socket.user?.current_geohash;
    if (zone) socket.join(`zone:${zone}`);

    // ── Enviar mensaje de chat ────────────────────────────────────────────────
    socket.on('send_message', async ({ zone_id, text }) => {
      if (!text || !zone_id || text.length > 500) return;

      try {
        const result = await pool.query(
          `INSERT INTO chat_messages (zone_id, user_id, text)
           VALUES ($1, $2, $3)
           RETURNING id, zone_id, user_id, text, created_at`,
          [zone_id, socket.user.id, text.trim()]
        );

        const msg = result.rows[0];
        const payload = {
          ...msg,
          public_name: socket.user.public_name,
        };

        // Emitir a todos en la zona (incluyendo emisor)
        io.to(`zone:${zone_id}`).emit('new_message', payload);

        // Actualizar last_active
        pool.query(
          'UPDATE users SET last_active = NOW() WHERE id = $1',
          [socket.user.id]
        ).catch(() => {});

      } catch (err) {
        console.error('send_message error:', err);
        socket.emit('error', { message: 'Error sending message' });
      }
    });

    // ── Unirse a zona específica ──────────────────────────────────────────────
    socket.on('join_zone', ({ zone_id }) => {
      if (zone_id) {
        socket.rooms.forEach(room => {
          if (room.startsWith('zone:')) socket.leave(room);
        });
        socket.join(`zone:${zone_id}`);
      }
    });

    // ── Unirse a canal ────────────────────────────────────────────────────────
    socket.on('join_channel', ({ channel_id }) => {
      if (channel_id) socket.join(`channel:${channel_id}`);
    });

    socket.on('leave_channel', ({ channel_id }) => {
      if (channel_id) socket.leave(`channel:${channel_id}`);
    });

    // ── Mensaje de canal ──────────────────────────────────────────────────────
    socket.on('send_channel_message', async ({ channel_id, text }) => {
      if (!text || !channel_id || text.length > 500) return;

      try {
        const result = await pool.query(
          `INSERT INTO channel_messages (channel_id, user_id, text)
           VALUES ($1, $2, $3)
           RETURNING id, channel_id, user_id, text, created_at`,
          [channel_id, socket.user.id, text.trim()]
        );

        const msg = result.rows[0];
        io.to(`channel:${channel_id}`).emit('new_channel_message', {
          ...msg,
          public_name: socket.user.public_name,
        });
      } catch (err) {
        console.error('send_channel_message error:', err);
      }
    });

    // ── Notificación de monedas (emitida desde rutas) ─────────────────────────
    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${socket.user?.public_name}`);
    });
  });

  // Exponer función para emitir desde rutas
  io.emitCoinsUpdate = (userId, coins) => {
    // Buscar socket del usuario y notificar
    for (const [, s] of io.sockets.sockets) {
      if (s.user?.id === userId) {
        s.emit('coins_update', { coins });
        break;
      }
    }
  };

  return io;
}

module.exports = setupSocket;
