/**
 * chaos.js  —  Hora del Caos
 *
 * Reglas:
 *  - Se activa 4 veces al día: 00:00, 06:00, 12:00, 18:00 (hora LOCAL del servidor)
 *  - Dura exactamente 15 minutos
 *  - Durante el caos: sin downvotes, sin karma, sin historial permanente
 *  - Los posts publicados en caos llevan is_chaos=true y se eliminan al terminar
 */

const CHAOS_HOURS    = [0, 6, 12, 18];   // horas de inicio
const CHAOS_DURATION = 15 * 60 * 1000;   // 15 minutos en ms

/**
 * Devuelve el estado actual del caos.
 * @returns {{ active: boolean, endsAt?: Date, nextAt: Date, secondsLeft?: number }}
 */
function getChaosState() {
  const now    = new Date();
  const h      = now.getHours();
  const m      = now.getMinutes();
  const s      = now.getSeconds();
  const msNow  = now.getTime();

  // ¿Estamos dentro de una ventana de caos?
  for (const chaosHour of CHAOS_HOURS) {
    if (h === chaosHour && m < 15) {
      const startedAt = new Date(now);
      startedAt.setHours(chaosHour, 0, 0, 0);
      const endsAt     = new Date(startedAt.getTime() + CHAOS_DURATION);
      const secondsLeft = Math.ceil((endsAt.getTime() - msNow) / 1000);

      return {
        active: true,
        startedAt,
        endsAt,
        secondsLeft,
        nextAt: _nextChaosAfter(now),
      };
    }
  }

  return {
    active:     false,
    secondsLeft: 0,
    nextAt:     _nextChaosAfter(now),
  };
}

/**
 * Calcula el próximo inicio de caos después de `from`.
 */
function _nextChaosAfter(from) {
  const d = new Date(from);

  for (let i = 0; i < 4; i++) {
    const candidate = new Date(d);
    const nextHour  = CHAOS_HOURS.find(
      ch => ch > d.getHours() || (ch === d.getHours() && d.getMinutes() >= 15)
        ? ch > d.getHours()
        : false
    );

    // Recorrer las horas de caos y encontrar la próxima
    for (const ch of CHAOS_HOURS) {
      if (ch > d.getHours() || (ch === d.getHours() && d.getMinutes() >= 15)) {
        candidate.setHours(ch, 0, 0, 0);
        return candidate;
      }
    }

    // Si no hay más hoy, pasar al día siguiente a las 00:00
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  return d;
}

/**
 * Middleware Express: rechaza downvotes durante el caos.
 */
function noChaosDownvote(req, res, next) {
  const { active } = getChaosState();
  if (active && req.body?.value === -1) {
    return res.status(403).json({
      error: 'No hay downvotes durante la Hora del Caos 😈',
      chaos: true,
    });
  }
  next();
}

/**
 * Limpia posts de caos que ya han terminado (llamar periódicamente).
 */
async function cleanChaosPostsIfNeeded(pool) {
  try {
    const { active } = getChaosState();
    if (!active) {
      // Borrar posts de caos de la última ventana ya cerrada
      const result = await pool.query(
        `DELETE FROM posts
         WHERE is_chaos = true
           AND created_at < NOW() - INTERVAL '15 minutes'
         RETURNING id`
      );
      if (result.rowCount > 0) {
        console.log(`🧹 Deleted ${result.rowCount} chaos posts`);
      }
    }
  } catch (err) {
    console.error('cleanChaosPostsIfNeeded error:', err);
  }
}

module.exports = { getChaosState, noChaosDownvote, cleanChaosPostsIfNeeded };
