require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const userRoutes      = require('./routes/users');
const feedRoutes      = require('./routes/feed');
const chatRoutes      = require('./routes/chat');
const coinsRoutes     = require('./routes/coins');
const challengeRoutes = require('./routes/challenges');
const treasureRoutes  = require('./routes/treasures');
const pollRoutes      = require('./routes/polls');
const channelRoutes   = require('./routes/channels');
const clanRoutes      = require('./routes/clans');
const rankingRoutes   = require('./routes/ranking');
const reportRoutes    = require('./routes/reports');
const visitorRoutes   = require('./routes/visitors');
const authEmailRoutes = require('./routes/auth_email');
const reactionsRoutes = require('./routes/reactions');
const socialRoutes    = require('./routes/social');
const dmRoutes        = require('./routes/dms');
const uploadRoutes    = require('./routes/upload');
const storiesRoutes   = require('./routes/stories');
const shopRoutes      = require('./routes/shop');
const warsRoutes      = require('./routes/wars');
const momentsRoutes   = require('./routes/moments');
const dopamineRoutes  = require('./routes/dopamine');
const setupSocket     = require('./socket');
const pool            = require('./db/pool');
const { cleanChaosPostsIfNeeded }              = require('./services/chaos');
const { recalcWeeklyPoints }                   = require('./routes/clans');
const { finalizeWars }                         = require('./routes/wars');
const { scheduleDailyMomento }                 = require('./routes/moments');
const { scheduleDuelResolution }               = require('./routes/dopamine');
const { checkZonaEnLlamas, applyKarmaDecay, getZoneMayor } = require('./services/zone');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET','POST'] },
});

app.set('io', io);
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
// Límite general pequeño; rutas de media tienen su propio middleware
// /upload/video usa multer (multipart) → no necesita express.json
app.use((req, res, next) => {
  if (req.path.startsWith('/upload/video')) return next(); // multer lo maneja
  const isMedia = ['/upload', '/user/avatar', '/stories', '/moments'].some(p => req.path.startsWith(p));
  const limit   = isMedia ? '10mb' : '50kb';
  express.json({ limit })(req, res, next);
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = (max, windowMs = 60_000) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Demasiadas peticiones, espera un momento.' }),
});

// General: 600 req/min por IP — la app hace ~10 peticiones en paralelo al arrancar
// y en prod puede haber carrier NAT (misma IP para varios usuarios)
app.use(limiter(600));

// Solo limitamos escrituras abusivas (POST/PUT/DELETE)
const writeOnly = (max, windowMs = 60_000) => (req, res, next) => {
  if (req.method === 'GET') return next();
  return limiter(max, windowMs)(req, res, next);
};

// Auth nunca se limita (el usuario puede estar reintentando login)
// app.use('/auth', ...); — sin límite adicional

app.use('/feed',      writeOnly(20));   // 20 posts/min
app.use('/reactions', writeOnly(60));   // 60 reacciones/min
app.use('/dopamine/daily-claim', limiter(10, 24 * 60 * 60_000)); // 10 intentos/día
app.use('/dopamine/duel',        writeOnly(10));
app.use('/chat',      writeOnly(40));

if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => { console.log(`${req.method} ${req.path}`); next(); });
}

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date() }));

// ── Alcalde de zona ───────────────────────────────────────────────────────────
app.get('/zone/mayor', async (req, res) => {
  const zone = (req.query.zone || '').slice(0, 4);
  if (!zone) return res.status(400).json({ error: 'zone requerido' });
  const mayor = await getZoneMayor(zone);
  res.json({ mayor });
});

app.use('/auth',       authEmailRoutes);
app.use('/user',       userRoutes);
app.use('/feed',       feedRoutes);
app.use('/chat',       chatRoutes);
app.use('/coins',      coinsRoutes);
app.use('/challenges', challengeRoutes);
app.use('/treasures',  treasureRoutes);
app.use('/polls',      pollRoutes);
app.use('/channels',   channelRoutes);
app.use('/clans',      clanRoutes);
app.use('/schools',    rankingRoutes);
app.use('/top3',       rankingRoutes);
app.use('/reports',    reportRoutes);
app.use('/visitor',    visitorRoutes);
app.use('/reactions',  reactionsRoutes);
app.use('/social',     socialRoutes);
app.use('/dms',        dmRoutes);
app.use('/upload',     uploadRoutes);
app.use('/stories',    storiesRoutes);
app.use('/shop',       shopRoutes);
app.use('/wars',       warsRoutes);
app.use('/moments',    momentsRoutes);
app.use('/dopamine',   dopamineRoutes);
app.use('/feed/:postId/comments', require('./routes/comments'));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

setupSocket(io);

setInterval(() => cleanChaosPostsIfNeeded(pool),  2 * 60 * 1000);
setInterval(() => recalcWeeklyPoints(pool),       60 * 60 * 1000);
setInterval(() => finalizeWars(),                 60 * 60 * 1000); // cada hora
scheduleDailyMomento(app);    // Momento ZAS diario a hora aleatoria
scheduleDuelResolution(app);  // Resolver duelos expirados cada hora
setInterval(checkZonaEnLlamas, 5 * 60_000);  // Zona en llamas cada 5 min
// Karma decay: una vez a la semana (cada 7 días)
setInterval(applyKarmaDecay, 7 * 24 * 60 * 60_000);
setInterval(async () => {
  try {
    // Limpiar visitors expirados
    const r = await pool.query('DELETE FROM visitors WHERE expires_at <= NOW()');
    if (r.rowCount > 0) console.log(`🧹 Cleaned ${r.rowCount} expired visitors`);
    // Limpiar stories expiradas
    const s = await pool.query('DELETE FROM stories WHERE expires_at <= NOW()');
    if (s.rowCount > 0) console.log(`🧹 Cleaned ${s.rowCount} expired stories`);
  } catch (err) { console.error('Cleanup error:', err); }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Zas backend on :${PORT} [V5 — imágenes, stories, tienda, clan wars, referidos]`);
});

module.exports = { app, server };
