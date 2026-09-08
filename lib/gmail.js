// Shared Gmail-sending helper, used by api/send-email.js and the password
// reset endpoints. See SETUP_GMAIL.md for how to obtain the required
// environment variables (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
// GMAIL_REFRESH_TOKEN, GMAIL_SENDER_EMAIL).

function base64url(input) {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildMimeMessage({ from, to, cc, subject, text, html }) {
  const boundary = 'portal_boundary_' + Math.random().toString(36).slice(2);
  const headerLines = [
    'From: ' + from,
    'To: ' + to,
  ];
  if (cc) headerLines.push('Cc: ' + cc);
  headerLines.push(
    'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"'
  );
  const headers = headerLines.join('\r\n');

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

function missingGmailEnv() {
  var requiredEnv = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_SENDER_EMAIL'];
  return requiredEnv.filter(function (k) { return !process.env[k]; });
}

// Salvavidas para Preview deployments: si en Vercel las variables de Gmail
// están configuradas para "todos los entornos" (lo default en el dashboard
// si no se separan explícitamente), cada preview de una rama/PR enviaría
// correo real desde administracion@moventiglobal.com sin que nadie lo pida
// a propósito. Por defecto, en un deployment que no es de producción esto
// no manda nada de verdad — solo lo registra. Ver README/tareas.md sobre
// separar variables de entorno por ambiente en el dashboard de Vercel, que
// es la forma correcta y definitiva de resolver esto; esto es solo la red
// de seguridad para mientras tanto (o si igual quedan compartidas a propósito).
function isNonProductionDeployment() {
  return process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production';
}

// Sends an email through the Gmail API using the pre-authorized refresh
// token. Throws on failure — callers decide how to surface that.
async function sendGmail({ to, cc, subject, text, html }) {
  var missing = missingGmailEnv();
  if (missing.length) {
    var err = new Error('missing_env');
    err.missing = missing;
    throw err;
  }
  if (isNonProductionDeployment() && process.env.ALLOW_PREVIEW_EMAIL !== 'true') {
    console.warn('[send-email] Bloqueado en entorno no-producción (' + process.env.VERCEL_ENV + '). ' +
      'No se envió correo real a: ' + to + (cc ? ' (cc: ' + cc + ')' : '') +
      '. Define ALLOW_PREVIEW_EMAIL=true en este entorno si de verdad quieres que Preview mande correo real.');
    return { id: 'preview-dry-run', dryRun: true };
  }
  var from = process.env.GMAIL_SENDER_EMAIL;
  var raw = base64url(buildMimeMessage({ from: from, to: to, cc: cc, subject: subject, text: text, html: html }));
  var accessToken = await getAccessToken();
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
    var sendErr = new Error('gmail_send_failed');
    sendErr.detail = sendData;
    throw sendErr;
  }
  return sendData;
}

module.exports = { sendGmail, missingGmailEnv };
