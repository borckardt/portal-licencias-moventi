// Permite al administrador, ya con sesión iniciada en el panel, cambiar su
// propia contraseña sin pasar por el flujo de correo de "olvidé mi
// contraseña" y sin tener que reingresar la contraseña actual — a pedido
// del usuario, solo se pide la nueva contraseña y su confirmación.
//
// La comprobación de identidad la da la sesión real emitida en
// verify-admin-login.js (cookie HttpOnly firmada, ver lib/adminSession.js).
// ANTES este endpoint solo comprobaba que el `username` del body coincidiera
// con el de la cuenta (un valor público, "admin") — es decir, cualquiera que
// tuviera el PORTAL_API_TOKEN (visible en el JS del sitio) podía cambiar la
// contraseña del administrador sin haber iniciado sesión nunca. Ahora, sin
// una cookie de sesión válida, esto se rechaza antes de tocar nada.
//
// NOTA para el admin actual: si ya tenías la sesión abierta desde antes de
// este cambio, tu navegador todavía no tiene la cookie nueva — cierra sesión
// y vuelve a entrar una vez para que este formulario funcione de nuevo.

const { getOrCreateAuth, saveAuth, hashPassword } = require('../lib/adminAuth');
const { getAdminSession } = require('../lib/adminSession');
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

  var rlKey = 'change-pwd:' + getClientIp(req);
  if (!allow(rlKey, 10, 10 * 60 * 1000)) {
    res.status(429).json({ ok: false, error: 'too_many_attempts' });
    return;
  }

  var session = getAdminSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: 'no_session' });
    return;
  }

  var body = req.body || {};
  var newPassword = body.newPassword || '';

  if (!newPassword || newPassword.length < 8) {
    res.status(400).json({ ok: false, error: 'invalid_input' });
    return;
  }

  try {
    var auth = await getOrCreateAuth();
    if (session.username !== auth.username) {
      res.status(401).json({ ok: false, error: 'invalid_current_password' });
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
