const pool = require('../db/pool');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Enviar notificación a un usuario por su ID
async function sendPush(userId, { title, body, data = {} }) {
  try {
    const result = await pool.query(
      'SELECT token FROM push_tokens WHERE user_id = $1',
      [userId]
    );
    if (!result.rows.length) return;

    const token = result.rows[0].token;
    await fetch(EXPO_PUSH_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default' }),
    });
  } catch (err) {
    console.error('Push send error:', err.message);
  }
}

module.exports = { sendPush };
