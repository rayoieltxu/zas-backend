require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const helmet  = require('helmet');

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
const { cleanChaosPostsIfNeeded } = require('./services/chaos');
const { recalcWeeklyPoints }      = require('./routes/clans');
const { finalizeWars }            = require('./routes/wars');
const { scheduleDailyMomento }    = require('./routes/moments');
const { scheduleDuelResolution }  = require('./routes/dopamine');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET','POST'] },
});

app.set('io', io);
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => { console.log(`${req.method} ${req.path}`); next(); });
}

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date() }));

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
