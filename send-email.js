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

function base64url(input) {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildMimeMessage({ from, to, subject, text, html }) {
  const boundary = 'portal_boundary_' + Math.random().toString(36).slice(2);
  const headers = [
    'From: ' + from,
    'To: ' + to,
    'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
  ].join('\r\n');

  const textPart =
    '--' + boundary + '\r\n' +
    'Content-Type: text/plain; charset="UTF-8"\r\n' +
    'Content-Transfer-Encoding: 7bit\r\n\r\n' +
    (text || '') + '\r\n';

  const htmlPart =
    '--' + boundary + '\r\n' +
    'Content-Type: text/html; charset="UTF-8"\r\n' +
    'Content-Transfer-Encoding: 7bit\r\n\r\n' +
    (html || '') + '\r\n';

  const closing = '--' + boundary + '--';

  return headers + '\r\n\r\n' + textPart + htmlPart + closing;
}

async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error('token_refresh_failed: ' + (data.error_description || data.error || resp.status));
  }
  return data.access_token;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const requiredEnv = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_SENDER_EMAIL'];
  const missing = requiredEnv.filter(function (k) { return !process.env[k]; });
  if (missing.length) {
    res.status(500).json({ ok: false, error: 'missing_env', missing: missing });
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
  var subject = (body.subject || '').trim();
  var text = body.text || '';
  var html = body.html || '';

  if (!to || !subject || (!text && !html)) {
    res.status(400).json({ ok: false, error: 'missing_fields' });
    return;
  }

  try {
    var accessToken = await getAccessToken();
    var from = process.env.GMAIL_SENDER_EMAIL;
    var raw = base64url(buildMimeMessage({ from: from, to: to, subject: subject, text: text, html: html }));

    var sendResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: raw }),
    });
    var sendData = await sendResp.json();
    if (!sendResp.ok) {
      res.status(502).json({ ok: false, error: 'gmail_send_failed', detail: sendData });
      return;
    }
    res.status(200).json({ ok: true, id: sendData.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
