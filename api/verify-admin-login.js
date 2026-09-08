// Verifies the admin's username/password against the persistent store
// (Vercel Blob), so the admin account survives across browsers/devices and
// password resets actually work. Client accounts are unaffected — they
// still live in each browser's localStorage as before.
//
// On success, also issues a real server-side session (HttpOnly cookie —
// ver lib/adminSession.js): antes de esto, un login exitoso era solo un
// estado del navegador (sessionStorage) sin nada que lo respalde del lado
// del servidor, así que otros endpoints sensibles (guardar todo el estado,
// cambiar la contraseña) no tenían forma de saber si quien llamaba
// realmente había iniciado sesión como admin.

const { getOrCreateAuth, saveAuth, verifyPassword, hashPassword, needsRehash } = require('../lib/adminAuth');
const { setSessionCookie } = require('../lib/adminSession');
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

  var body = req.body || {};
  var username = (body.username || '').trim();
  var password = body.password || '';
  if (!username || !password) {
    res.status(400).json({ ok: false, error: 'missing_fields' });
    return;
  }

  // Rate limit básico: 10 intentos cada 10 minutos por IP+usuario (ver
  // lib/rateLimit.js sobre las limitaciones de esto en serverless).
  var rlKey = 'login:' + getClientIp(req) + ':' + username.toLowerCase();
  if (!allow(rlKey, 10, 10 * 60 * 1000)) {
    res.status(429).json({ ok: false, error: 'too_many_attempts' });
    return;
  }

  try {
    var auth = await getOrCreateAuth();
    var ok = username === auth.username && await verifyPassword(password, auth.passwordHash);
    if (ok) {
      // Migración transparente del hash viejo (SHA-256 simple) al nuevo
      // (scrypt), igual que ya se hace en el navegador para las contraseñas
      // de clientes que aún tuvieran texto plano.
      if (needsRehash(auth.passwordHash)) {
        auth.passwordHash = await hashPassword(password);
        await saveAuth(auth).catch(function () {});
      }
      setSessionCookie(res, auth.username);
    }
    res.status(200).json({ ok: ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
