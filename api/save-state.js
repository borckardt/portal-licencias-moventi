// Saves the shared portal state (clients, license types, requests,
// settings) to Vercel Blob. The client sends its full local state after
// merging in whatever changed remotely (see mergeCollection in app.js), so
// this endpoint just writes what it's given if the caller is an
// authenticated admin (real session, ver lib/adminSession.js).
//
// Si NO hay sesión de admin, en vez de guardar a ciegas cualquier cosa que
// llegue con el PORTAL_API_TOKEN (público, visible en el JS del sitio — ver
// nota en send-email.js), se valida contra lo último guardado que el único
// cambio sea el que un cliente legítimo puede hacer desde su pantalla:
// agregar una solicitud nueva propia (ver lib/appStateGuard.js). Cualquier
// otra cosa (usuarios, tipos de licencia, configuración, o tocar una
// solicitud ya existente) se rechaza con 403.

const { loadAppState, saveAppState } = require('../lib/appState');
const { getAdminSession } = require('../lib/adminSession');
const { checkNonAdminSave } = require('../lib/appStateGuard');

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
  var body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ ok: false, error: 'invalid_body' });
    return;
  }

  try {
    var session = getAdminSession(req);
    if (!session) {
      var prevState = await loadAppState();
      var check = checkNonAdminSave(prevState, body);
      if (!check.ok) {
        res.status(403).json({ ok: false, error: 'forbidden', reason: check.reason });
        return;
      }
    }
    await saveAppState(body);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
