// Serverless function (Vercel) que envía correo por SMTP con la contraseña de
// aplicación de Gmail (ver lib/gmail.js y SETUP_GMAIL.md). Lo usan el botón
// "Enviar solicitud por correo" del panel y el aviso automático de "nueva
// solicitud" que se dispara cuando un cliente envía una (ver notifyNewRequest
// en app.js).
//
// Variables de entorno (Vercel → Project → Settings → Environment Variables):
//   GMAIL_SENDER_EMAIL - buzón desde el que se envía (notificaciones@moventiglobal.com)
//   GMAIL_APP_PASSWORD - contraseña de aplicación de ese buzón
//   PORTAL_API_TOKEN   - token compartido que el front manda en "x-portal-token".
//                        Como el sitio es estático, ese token vive en el JS de
//                        la página y no es un secreto fuerte: solo frena abuso
//                        casual. Lo que de verdad evita que esto sea un relay
//                        abierto es la lista blanca de destinatarios de abajo.

const { sendGmail } = require('../lib/gmail');
const { loadAppState } = require('../lib/appState');
const { INTERNAL_NOTIFY_EMAILS } = require('../lib/constants');

function parseEmailList(str) {
  return String(str || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

// Solo se permite enviar a direcciones que el propio sistema ya conoce: las
// internas de aviso, el correo de contacto/copias que el admin configuró para
// el envío de solicitudes, y los destinatarios que el admin registró en la
// pestaña "Notificaciones" (settings.notifyEmails) — sin estos últimos, el
// aviso de nueva solicitud a un colaborador se rechazaba con 403.
async function buildAllowlist() {
  var allow = INTERNAL_NOTIFY_EMAILS.map(function (s) { return s.toLowerCase(); });
  try {
    var state = await loadAppState();
    var settings = state && state.settings;
    if (settings) {
      if (settings.ingramEmail) allow.push(String(settings.ingramEmail).trim().toLowerCase());
      if (settings.ingramCc) allow = allow.concat(parseEmailList(settings.ingramCc));
      if (Array.isArray(settings.notifyEmails)) {
        settings.notifyEmails.forEach(function (n) {
          if (n && n.email) allow.push(String(n.email).trim().toLowerCase());
        });
      }
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
  // cc puede llegar como array (['a@x.com','b@y.com']) o como string ya unida
  // por comas; en ambos casos la normalizamos a "a, b" para el header Cc.
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
