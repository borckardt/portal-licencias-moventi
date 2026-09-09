// Shared Gmail-sending helper, used by api/send-email.js and the password
// reset endpoints.
//
// Envía por SMTP usando una contraseña de aplicación de Gmail (App Password),
// no por la API de Gmail con OAuth. Esto evita tener que crear un proyecto en
// Google Cloud Console (que es lo que aparecía en el desglose de facturación
// de la cuenta de Google) y no requiere tarjeta de crédito.
//
// Cómo generarla:
//   1) Activar verificación en 2 pasos en la cuenta administracion@moventiglobal.com
//      (myaccount.google.com/security).
//   2) Ir a https://myaccount.google.com/apppasswords, crear una app password
//      nueva (nombre sugerido: "Portal de licencias").
//   3) Copiar el valor de 16 caracteres que da Google (sin espacios) y
//      guardarlo en Vercel como la variable de entorno GMAIL_APP_PASSWORD.
//
// Variables de entorno requeridas: GMAIL_SENDER_EMAIL, GMAIL_APP_PASSWORD.

const nodemailer = require('nodemailer');

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_SENDER_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return cachedTransporter;
}

function missingGmailEnv() {
  var requiredEnv = ['GMAIL_SENDER_EMAIL', 'GMAIL_APP_PASSWORD'];
  return requiredEnv.filter(function (k) { return !process.env[k]; });
}

// Sends an email through Gmail's SMTP server using an app password. Throws
// on failure — callers decide how to surface that.
async function sendGmail({ to, cc, subject, text, html }) {
  var missing = missingGmailEnv();
  if (missing.length) {
    var err = new Error('missing_env');
    err.missing = missing;
    throw err;
  }
  var from = process.env.GMAIL_SENDER_EMAIL;
  try {
    var info = await getTransporter().sendMail({
      from: from,
      to: to,
      cc: cc || undefined,
      subject: subject,
      text: text,
      html: html,
    });
    // messageId/accepted/rejected para poder diagnosticar entregas: un 'ok'
    // pelado no distingue "Gmail lo acepto" de "rechazo un destinatario".
    return {
      messageId: info && info.messageId,
      accepted: (info && info.accepted) || [],
      rejected: (info && info.rejected) || [],
      response: info && info.response
    };
  } catch (sendErr) {
    var wrapped = new Error('gmail_send_failed');
    wrapped.detail = String(sendErr && sendErr.message || sendErr);
    throw wrapped;
  }
}

module.exports = { sendGmail, missingGmailEnv };
