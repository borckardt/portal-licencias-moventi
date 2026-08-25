// Serverless function (Vercel) that sends an email through the Gmail API
// using a pre-authorized refresh token, so the "Enviar solicitud por correo"
// button in the portal can send automatically — no mailto:, no manual step.
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
//                          determined actor who reads the page source.
//
// See SETUP_GMAIL.md in this folder for how to obtain each value.

const { sendGmail } = require('../lib/gmail');

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
