// Starts the "olvidé mi contraseña" flow for the admin account: generates a
// short-lived reset token, stores it in the persistent auth store (Vercel
// Blob), and emails a reset link to the registered recovery addresses.

const crypto = require('crypto');
const { getOrCreateAuth, saveAuth, RESET_TOKEN_TTL_MS } = require('../lib/adminAuth');
const { sendGmail } = require('../lib/gmail');

// A la vez que llega la solicitud de nueva licencia, el enlace de
// restablecimiento se envía a estas mismas cuentas de recuperación.
const RECOVERY_EMAILS = ['sborckardt@moventiglobal.com', 'administracion@moventiglobal.com'];

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

  try {
    var auth = await getOrCreateAuth();
    // Solo generamos y enviamos el token si el usuario coincide, pero
    // siempre respondemos igual (ok:true) para no revelar si el usuario
    // existe o no.
    if (username && username === auth.username) {
      var token = crypto.randomBytes(24).toString('hex');
      auth.resetToken = token;
      auth.resetTokenExpiresAt = Date.now() + RESET_TOKEN_TTL_MS;
      await saveAuth(auth);

      var proto = req.headers['x-forwarded-proto'] || 'https';
      var origin = proto + '://' + req.headers.host;
      var link = origin + '/?resetToken=' + token;

      var subject = 'Restablecer contraseña — Portal de licencias Moventi';
      var text =
        'Se solicitó restablecer la contraseña del administrador (' + auth.username + ') del Portal de licencias Moventi.\n\n' +
        'Si fuiste tú, entra a este enlace para crear una nueva contraseña (válido 30 minutos):\n' + link + '\n\n' +
        'Si no fuiste tú, ignora este correo — tu contraseña actual sigue funcionando.';
      var html =
        '<div style="font-family:Arial,sans-serif;font-size:14px">' +
        '<p>Se solicitó restablecer la contraseña del administrador (<strong>' + auth.username + '</strong>) del Portal de licencias Moventi.</p>' +
        '<p>Si fuiste tú, haz clic para crear una nueva contraseña (válido 30 minutos):</p>' +
        '<p><a href="' + link + '" style="display:inline-block;background:#6d5efc;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Restablecer contraseña</a></p>' +
        '<p style="color:#666;font-size:12px">Si el botón no funciona, copia y pega este enlace en tu navegador:<br>' + link + '</p>' +
        '<p>Si no fuiste tú, ignora este correo — tu contraseña actual sigue funcionando.</p>' +
        '</div>';

      await sendGmail({ to: RECOVERY_EMAILS.join(', '), subject: subject, text: text, html: html });
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
