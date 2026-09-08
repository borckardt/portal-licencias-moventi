// Completes the "olvidé mi contraseña" flow: validates the reset token and
// sets a new password for the admin account in the persistent auth store.

const { getOrCreateAuth, saveAuth, hashPassword } = require('../lib/adminAuth');
const { allow, getClientIp } = require('../lib/rateLimit');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (process.env.PORTAL_API_TOKEN) {
    var provided = req.headers['x-portal-token'];
    if (provided !== process.env.PORTAL_API_TOKEN) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  // El token tiene 192 bits de entropía (ver request-password-reset.js), así
  // que no es adivinable por fuerza bruta en la práctica — este límite es
  // solo una capa extra barata.
  var rlKey = 'reset-pwd:' + getClientIp(req);
  if (!allow(rlKey, 20, 10 * 60 * 1000)) {
    res.status(429).json({ ok: false, error: 'too_many_attempts' });
    return;
  }

  var body = req.body || {};
  var token = (body.token || '').trim();
  var newPassword = body.newPassword || '';

  if (!token || !newPassword || newPassword.length < 8) {
    res.status(400).json({ ok: false, error: 'invalid_input' });
    return;
  }

  try {
    var auth = await getOrCreateAuth();
    if (!auth.resetToken || auth.resetToken !== token) {
      res.status(400).json({ ok: false, error: 'invalid_token' });
      return;
    }
    if (!auth.resetTokenExpiresAt || Date.now() > auth.resetTokenExpiresAt) {
      res.status(400).json({ ok: false, error: 'expired_token' });
      return;
    }
    auth.passwordHash = await hashPassword(newPassword);
    auth.resetToken = null;
    auth.resetTokenExpiresAt = null;
    await saveAuth(auth);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
