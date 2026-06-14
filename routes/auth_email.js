/**
 * routes/auth_email.js
 * Registro, login, verificación y recuperación de contraseña con email
 * Email: Resend HTTP API (evita bloqueo de puertos SMTP en Render free)
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const https   = require('https');

const APP_URL = process.env.APP_URL || 'https://zas-backend-9uml.onrender.com';

// ── Email vía Resend HTTP API ─────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY no configurada');

  const body = JSON.stringify({
    from:    process.env.EMAIL_FROM || 'ZAS App <onboarding@resend.dev>',
    to:      [to],
    subject,
    html,
  });

  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('📧 Email enviado a', to, '— status:', res.statusCode);
          resolve(data);
        } else {
          reject(new Error(`Resend error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, public_name, geohash, device_id, is_under_16 } = req.body;

  if (!email || !password || !public_name || !geohash || !device_id)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  if (public_name.length < 2 || public_name.length > 50)
    return res.status(400).json({ error: 'El nombre debe tener entre 2 y 50 caracteres' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email inválido' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'Este email ya está registrado' });

    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken  = randomToken();
    const verifyExp    = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Liberar device_id si pertenece a otra cuenta
    await pool.query('UPDATE users SET device_id=NULL WHERE device_id=$1', [device_id]);

    const result = await pool.query(
      `INSERT INTO users
         (email, password_hash, public_name, current_geohash, device_id,
          is_under_16, email_verified, verify_token, verify_expires)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8)
       RETURNING id, public_name, email`,
      [email.toLowerCase(), passwordHash, public_name.trim(), geohash,
       device_id, is_under_16 || false, verifyToken, verifyExp]
    );
    const user = result.rows[0];

    // Inicializar monedas y racha
    await Promise.all([
      pool.query('INSERT INTO user_coins (user_id, coins) VALUES ($1,0) ON CONFLICT DO NOTHING', [user.id]),
      pool.query('INSERT INTO user_streaks (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]),
    ]);

    // Enviar email de verificación
    const verifyUrl = `${APP_URL}/auth/verify/${verifyToken}`;
    await sendEmail({
      to:      email,
      subject: '✅ Verifica tu cuenta de Zas',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h1 style="font-size:32px;font-weight:900;letter-spacing:6px;color:#0F1419">ZAS</h1>
          <p style="color:#536471;font-size:16px">Hola <strong>${user.public_name}</strong>,</p>
          <p style="color:#536471">Para activar tu cuenta haz clic en el botón. El enlace expira en 24 horas.</p>
          <a href="${verifyUrl}"
             style="display:inline-block;margin:24px 0;padding:14px 28px;
                    background:#0F1419;color:#fff;text-decoration:none;
                    border-radius:24px;font-weight:700;font-size:16px">
            Verificar email →
          </a>
          <p style="color:#8899A6;font-size:13px">Si no creaste esta cuenta, ignora este mensaje.</p>
        </div>
      `,
    });

    res.status(201).json({
      message: 'Cuenta creada. Revisa tu email para verificarla.',
      email_pending_verification: true,
    });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Email o nombre ya en uso' });
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /auth/verify/:token ───────────────────────────────────────────────────
router.get('/verify/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const result = await pool.query(
      `UPDATE users SET email_verified=true, verify_token=NULL, verify_expires=NULL
       WHERE verify_token=$1 AND verify_expires > NOW()
       RETURNING id, public_name`,
      [token]
    );
    if (result.rows.length === 0)
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>❌ Enlace inválido o expirado</h2>
          <p>Solicita un nuevo email de verificación desde la app.</p>
        </body></html>
      `);

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f7f9f9">
        <h1 style="font-size:48px;letter-spacing:8px;color:#0F1419">ZAS</h1>
        <h2 style="color:#00BA7C">✅ Email verificado</h2>
        <p style="color:#536471;font-size:18px">¡Bienvenido/a, ${result.rows[0].public_name}!<br>Ya puedes abrir la app e iniciar sesión.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).send('Error interno');
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password, device_id, geohash } = req.body;
  if (!email || !password || !device_id)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    const user = result.rows[0];

    if (!await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    if (!user.email_verified)
      return res.status(403).json({
        error: 'Debes verificar tu email antes de entrar',
        code: 'EMAIL_NOT_VERIFIED',
        email: user.email,
      });

    await pool.query('UPDATE users SET device_id=NULL WHERE device_id=$1 AND id != $2', [device_id, user.id]);
    await pool.query(
      'UPDATE users SET device_id=$1, current_geohash=$2, last_active=NOW() WHERE id=$3',
      [device_id, geohash || user.current_geohash, user.id]
    );

    const [coinsRow, streakRow] = await Promise.all([
      pool.query('SELECT coins FROM user_coins WHERE user_id=$1', [user.id]),
      pool.query('SELECT * FROM user_streaks WHERE user_id=$1', [user.id]),
    ]);

    res.json({
      user: {
        id: user.id,
        public_name: user.public_name,
        email: user.email,
        karma: user.karma,
        created_at: user.created_at,
        current_geohash: geohash || user.current_geohash,
        radius_km: user.radius_km,
        is_under_16: user.is_under_16,
        school_id: user.school_id,
        coins: coinsRow.rows[0]?.coins ?? 0,
        streak: streakRow.rows[0] ?? { current_streak: 0, longest_streak: 0 },
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /auth/resend-verification ───────────────────────────────────────────
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email=$1 AND email_verified=false',
      [email.toLowerCase()]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Email no encontrado o ya verificado' });

    const user        = result.rows[0];
    const verifyToken = randomToken();
    const verifyExp   = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      'UPDATE users SET verify_token=$1, verify_expires=$2 WHERE id=$3',
      [verifyToken, verifyExp, user.id]
    );

    const verifyUrl = `${APP_URL}/auth/verify/${verifyToken}`;
    await sendEmail({
      to:      email,
      subject: '✅ Verifica tu cuenta de Zas',
      html: `<p>Hola ${user.public_name}, <a href="${verifyUrl}">verifica tu email aquí</a>. Expira en 24h.</p>`,
    });

    res.json({ message: 'Email de verificación reenviado' });
  } catch (err) {
    console.error('Resend error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /auth/forgot-password ────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (result.rows.length === 0)
      return res.json({ message: 'Si el email existe recibirás un enlace' });

    const user       = result.rows[0];
    const resetToken = randomToken();
    const resetExp   = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1h

    await pool.query(
      'UPDATE users SET reset_token=$1, reset_expires=$2 WHERE id=$3',
      [resetToken, resetExp, user.id]
    );

    const resetUrl = `${APP_URL}/auth/reset-password/${resetToken}`;
    await sendEmail({
      to:      email,
      subject: '🔑 Recupera tu contraseña de Zas',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h1 style="font-size:32px;font-weight:900;letter-spacing:6px;color:#0F1419">ZAS</h1>
          <p style="color:#536471">Haz clic en el botón para crear una nueva contraseña. El enlace expira en 1 hora.</p>
          <a href="${resetUrl}"
             style="display:inline-block;margin:24px 0;padding:14px 28px;
                    background:#0F1419;color:#fff;text-decoration:none;
                    border-radius:24px;font-weight:700;font-size:16px">
            Restablecer contraseña →
          </a>
        </div>
      `,
    });

    res.json({ message: 'Si el email existe recibirás un enlace' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /auth/reset-password/:token ──────────────────────────────────────────
router.get('/reset-password/:token', async (req, res) => {
  const { token } = req.params;
  const result = await pool.query(
    'SELECT id FROM users WHERE reset_token=$1 AND reset_expires > NOW()',
    [token]
  );
  if (result.rows.length === 0)
    return res.status(400).send('<h2>❌ Enlace inválido o expirado</h2>');

  res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:60px auto;padding:24px">
      <h1 style="letter-spacing:6px">ZAS</h1>
      <h2>Nueva contraseña</h2>
      <form method="POST" action="/auth/reset-password/${token}">
        <input name="password" type="password" placeholder="Nueva contraseña (mín. 6 caracteres)"
               style="width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:8px;margin:12px 0">
        <button type="submit"
                style="width:100%;padding:14px;background:#0F1419;color:#fff;
                       border:none;border-radius:8px;font-size:16px;cursor:pointer">
          Guardar contraseña
        </button>
      </form>
    </body></html>
  `);
});

// ── POST /auth/reset-password/:token ─────────────────────────────────────────
router.post('/reset-password/:token', express.urlencoded({ extended: false }), async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  if (!password || password.length < 6)
    return res.status(400).send('<h2>La contraseña debe tener al menos 6 caracteres</h2>');

  try {
    const hash   = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `UPDATE users SET password_hash=$1, reset_token=NULL, reset_expires=NULL
       WHERE reset_token=$2 AND reset_expires > NOW()
       RETURNING public_name`,
      [hash, token]
    );
    if (result.rows.length === 0)
      return res.status(400).send('<h2>❌ Enlace inválido o expirado</h2>');

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1 style="letter-spacing:6px">ZAS</h1>
        <h2 style="color:#00BA7C">✅ Contraseña actualizada</h2>
        <p>Ya puedes iniciar sesión en la app con tu nueva contraseña.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).send('Error interno');
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) return res.status(400).json({ error: 'Device ID requerido' });
  try {
    await pool.query('UPDATE users SET device_id=NULL WHERE device_id=$1', [deviceId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
