const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const { getLiveRanking, getHistoricTop3, updateSocialLinks } = require('../services/top3');

// ════════════════════════════════════════════════════════
//  VERIFICACIÓN ESCOLAR
// ════════════════════════════════════════════════════════

// POST /schools/verify → verificar con código del centro
router.post('/verify', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  try {
    const school = await pool.query(
      `SELECT * FROM schools WHERE verification_code = $1`, [code.trim().toUpperCase()]
    );
    if (school.rows.length === 0)
      return res.status(404).json({ error: 'Código de verificación inválido' });

    const s = school.rows[0];

    // Insertar verificación
    await pool.query(
      `INSERT INTO verified_students (user_id, school_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, s.id]
    );

    // Actualizar school_id en el perfil del usuario
    await pool.query(
      `UPDATE users SET school_id = $1 WHERE id = $2`, [s.id, req.user.id]
    );

    res.json({ ok: true, school: { id: s.id, name: s.name } });
  } catch (err) {
    console.error('POST /schools/verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /schools/my → centro verificado del usuario
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name FROM schools s
       JOIN verified_students vs ON vs.school_id = s.id
       WHERE vs.user_id = $1`, [req.user.id]
    );
    res.json({ school: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /schools/verify → quitar verificación
router.delete('/verify', auth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM verified_students WHERE user_id = $1`, [req.user.id]);
    await pool.query(`UPDATE users SET school_id = NULL WHERE id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════
//  TOP 3 MENSUAL
// ════════════════════════════════════════════════════════

// GET /top3?zone=geohash → ranking en tiempo real
router.get('/', auth, async (req, res) => {
  const zone = req.query.zone || req.user.current_geohash;
  try {
    const ranking = await getLiveRanking(zone, 10);

    // Marcar posición del usuario actual
    const myRank = ranking.findIndex(r => r.id === req.user.id) + 1;

    res.json({ ranking, my_rank: myRank || null, zone });
  } catch (err) {
    console.error('GET /top3 error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /top3/historic?zone=&period=YYYY-MM → top 3 histórico
router.get('/historic', auth, async (req, res) => {
  const zone      = req.query.zone || req.user.current_geohash;
  const periodKey = req.query.period || new Date().toISOString().slice(0, 7);
  try {
    const top3 = await getHistoricTop3(zone, periodKey);
    res.json({ top3, period: periodKey });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /top3/social-links → el ganador actualiza sus redes
router.put('/social-links', auth, async (req, res) => {
  const { instagram, tiktok, twitter } = req.body;
  const zone      = req.user.current_geohash;
  const periodKey = new Date().toISOString().slice(0, 7);

  // Validación básica de formato
  const links = {};
  if (instagram) links.instagram = instagram.replace(/^@/, '').trim();
  if (tiktok)    links.tiktok    = tiktok.replace(/^@/, '').trim();
  if (twitter)   links.twitter   = twitter.replace(/^@/, '').trim();

  try {
    await updateSocialLinks(req.user.id, zone, periodKey, links);
    res.json({ ok: true, social_links: links });
  } catch (err) {
    if (err.message === 'NOT_IN_TOP3')
      return res.status(403).json({ error: 'Solo el Top 3 puede añadir redes sociales' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
