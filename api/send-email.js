// Serverless function (Vercel) that sends an email through the Gmail API
// using a pre-authorized refresh token, so the "Enviar solicitud por correo"
// button in the portal can send automatically — no mailto:, no manual step.
// También lo usa el aviso automático de "nueva solicitud" que se dispara
// cuando un cliente envía una solicitud (ver notifyNewRequest en app.js).
//
// Required environment variables (set in Vercel → Project → Settings → Environment Variables):
//   GMAIL_CLIENT_ID      - OAuth 2.0 Client ID (Web application) from Google Cloud Console
//   GMAIL_CLIENT_SECRET  - OAuth 2.0 Client Secret for that same client
//   GMAIL_REFRESH_TOKEN  - Refresh token obtained once, authorized as the sending mailbox
//                          (e.g. administracion@moventiglobal.com), with scope
//                          https://www.googleapis.com/auth/gmail.send
//   GMAIL_SENDER_EMAIL   - The mailbox that authorized the refresh token, used as the
//                          "From" address (e.g. administracion@moventiglobal.com)
//   PORTAL_API_TOKEN     - A shared token the front-end sends in the
//                          "x-portal-token" header, so this endpoint isn't a fully
//                          open mail relay. NOTE: since this is a static-site front end,
//                          this token lives in the page's own JS and is not a strong
//                          secret — it only blocks casual/automated abuse, not a
//                          determined actor who reads the page source. That's exactly
//                          why `to`/`cc` are restricted to a computed allowlist below
//                          instead of trusting whatever the caller sends.
//
// See SETUP_GMAIL.md in this folder for how to obtain each value.

const { sendGmail } = require('../lib/gmail');
const { loadAppState } = require('../lib/appState');
const { INTERNAL_NOTIFY_EMAILS } = require('../lib/constants');

function parseEmailList(str) {
  return String(str || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

// Antes, este endpoint mandaba a cualquier `to`/`cc` que llegara en el body,
// protegido solo por PORTAL_API_TOKEN — como ese token es público (vive en
// el JS del sitio), cualquiera que lo copiara podía usar la cuenta de Gmail
// configurada (administracion@moventiglobal.com) como relay para mandar
// correo a cualquier destinatario. Ahora solo se permite mandar a
// direcciones que el propio sistema ya conoce y usa: las internas de aviso,
// y el correo de contacto / copias que el admin configuró en "Tipos de
// licencia" (STATE.settings.ingramEmail / ingramCc).
async function buildAllowlist() {
  var allow = INTERNAL_NOTIFY_EMAILS.map(function (s) { return s.toLowerCase(); });
  try {
    var state = await loadAppState();
    var settings = state && state.settings;
    if (settings) {
      if (settings.ingramEmail) allow.push(String(settings.ingramEmail).trim().toLowerCase());
      if (settings.ingramCc) allow = allow.concat(parseEmailList(settings.ingramCc));
    }
  } catch (e) { /* si falla la lectura, seguimos solo con las internas */ }
  return allow;
}

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
  var to = (body.to || '').trim();
  // cc puede llegar como array (['a@x.com','b@y.com']) o como string ya
  // unida por comas; en ambos casos la normalizamos a un string "a, b" para
  // el header Cc del correo (o vacío si no hay copias).
  var ccArr = Array.isArray(body.cc) ? body.cc : (typeof body.cc === 'string' ? body.cc.split(',') : []);
  var cc = ccArr.map(function (s) { return String(s || '').trim(); }).filter(function (s) { return s; }).join(', ');
  var subject = (body.subject || '').trim();
  var text = body.text || '';
  var html = body.html || '';

  if (!to || !subject || (!text && !html)) {
    res.status(400).json({ ok: false, error: 'missing_fields' });
    return;
  }

  var allowlist = await buildAllowlist();
  // `to` puede traer varias direcciones separadas por coma (ver
  // notifyNewRequest en app.js); cada una debe estar en la lista blanca.
  var recipients = parseEmailList(to).concat(parseEmailList(cc));
  var blocked = recipients.filter(function (addr) { return allowlist.indexOf(addr) === -1; });
  if (blocked.length) {
    res.status(403).json({ ok: false, error: 'recipient_not_allowed', blocked: blocked });
    return;
  }

  try {
    var sendData = await sendGmail({ to: to, cc: cc, subject: subject, text: text, html: html });
    res.status(200).json({ ok: true, id: sendData.id });
  } catch (err) {
    if (err && err.message === 'missing_env') {
      res.status(500).json({ ok: false, error: 'missing_env', missing: err.missing });
    } else if (err && err.message === 'gmail_send_failed') {
      res.status(502).json({ ok: false, error: 'gmail_send_failed', detail: err.detail });
    } else {
      res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
    }
  }
};
