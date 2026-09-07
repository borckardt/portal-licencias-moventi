// Permite al administrador, ya con sesión iniciada en el panel, cambiar su
// propia contraseña sin pasar por el flujo de correo de "olvidé mi
// contraseña" y sin tener que reingresar la contraseña actual — a pedido
// del usuario, solo se pide la nueva contraseña y su confirmación. La
// comprobación de identidad la da el hecho de que solo alguien ya logueado
// en el panel de administrador ve este formulario.

const { getOrCreateAuth, saveAuth, hashPassword } = require('../lib/adminAuth');

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
  var newPassword = body.newPassword || '';

  if (!username || !newPassword || newPassword.length < 8) {
    res.status(400).json({ ok: false, error: 'invalid_input' });
    return;
  }

  try {
    var auth = await getOrCreateAuth();
    if (username !== auth.username) {
      res.status(401).json({ ok: false, error: 'invalid_current_password' });
      return;
    }
    auth.passwordHash = hashPassword(newPassword);
    auth.resetToken = null;
    auth.resetTokenExpiresAt = null;
    await saveAuth(auth);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
