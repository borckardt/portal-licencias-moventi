// Envío programado de solicitudes a Ingram. Lo dispara el cron de Vercel una
// vez al día (ver "crons" en vercel.json): busca las solicitudes aprobadas que
// el admin dejó programadas (scheduledSend) con fecha de hoy o anterior, manda
// UN correo con todas ellas al contacto configurado, las marca como enviadas y
// avisa por correo a los destinatarios de la pestaña Notificaciones.
//
// Auth: el cron de Vercel manda "Authorization: Bearer $CRON_SECRET" si esa
// variable existe; también se acepta el x-portal-token para poder ejecutarlo a
// mano desde el panel ("Ejecutar programados ahora").

const { sendGmail } = require('../lib/gmail');
const { loadAppState, saveAppState } = require('../lib/appState');
const { INTERNAL_NOTIFY_EMAILS } = require('../lib/constants');

var DEFAULT_SUBJECT = 'Solicitud de habilitación de licencias — Moventi ({{cantidad}} {{unidad}})';
var DEFAULT_BODY = 'Hola,\n\nSe solicita generar/habilitar las siguientes licencias aprobadas:\n\n{{detalle}}\n\nSaludos,\n{{admin}}';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ymdLima() {
  // 'en-CA' da YYYY-MM-DD; la zona fija evita que el cron (UTC) adelante un día.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

function fmtDateShort(ymd) {
  if (!ymd) return '—';
  var p = String(ymd).slice(0, 10).split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

function parseEmailList(str) {
  return String(str || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, function (_, k) {
    return (k in vars) ? String(vars[k]) : '';
  });
}

// Igual que renderTemplateHtml del front: escapa el texto plano y permite
// insertar {{detalle}} como tabla HTML real.
function renderTemplateHtml(tpl, vars, overrides) {
  var re = /\{\{(\w+)\}\}/g, src = String(tpl || ''), out = '', last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) out += esc(src.slice(last, m.index)).replace(/\n/g, '<br>');
    var k = m[1];
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, k)) out += overrides[k];
    else out += esc(k in vars ? String(vars[k]) : '');
    last = re.lastIndex;
  }
  if (last < src.length) out += esc(src.slice(last)).replace(/\n/g, '<br>');
  return out;
}

function authorized(req) {
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization === 'Bearer ' + cronSecret) return true;
  if (process.env.PORTAL_API_TOKEN && req.headers['x-portal-token'] === process.env.PORTAL_API_TOKEN) return true;
  // Sin CRON_SECRET configurado, aceptamos al cron de Vercel por su user-agent.
  if (!cronSecret && /^vercel-cron/i.test(String(req.headers['user-agent'] || ''))) return true;
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  var state;
  try {
    state = await loadAppState();
  } catch (err) {
    res.status(500).json({ ok: false, error: 'state_read_failed', detail: String(err && err.message || err) });
    return;
  }
  if (!state || !Array.isArray(state.requests)) {
    res.status(200).json({ ok: true, sent: 0, note: 'sin_estado' });
    return;
  }

  var settings = state.settings || {};
  var today = ymdLima();
  var due = state.requests.filter(function (r) {
    return r.status === 'aprobado' && !r.notifiedToIngram && r.scheduledSend &&
      String(r.scheduledSend).slice(0, 10) <= today;
  });

  if (due.length === 0) {
    res.status(200).json({ ok: true, sent: 0, today: today });
    return;
  }

  var ingramEmail = String(settings.ingramEmail || '').trim();
  if (!ingramEmail) {
    res.status(200).json({ ok: false, error: 'sin_correo_configurado', pending: due.length });
    return;
  }
  var ccList = parseEmailList(settings.ingramCc);

  var detalle = due.map(function (r) {
    return '- ' + r.licenseTypeName + ' | Proyecto: ' + (r.project || '—') + ' | Cantidad: ' +
      (r.quantity || 1) + ' | Cliente: ' + r.clientName + ' | Fecha de Activación: ' + fmtDateShort(r.neededFrom);
  }).join('\n');
  var detalleHtml = '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:.4em 0">' +
    '<tr style="background:#f3f4f6"><th style="padding:6px 10px;text-align:left">Tipo</th><th style="padding:6px 10px;text-align:left">Proyecto</th><th style="padding:6px 10px;text-align:center">Cantidad</th><th style="padding:6px 10px;text-align:left">Cliente</th><th style="padding:6px 10px;text-align:left">Fecha de Activación</th></tr>' +
    due.map(function (r) {
      return '<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">' + esc(r.licenseTypeName) + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">' + esc(r.project || '—') + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">' + (r.quantity || 1) + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">' + esc(r.clientName) + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">' + fmtDateShort(r.neededFrom) + '</td></tr>';
    }).join('') + '</table>';

  var vars = {
    cantidad: due.length,
    unidad: due.length === 1 ? 'solicitud' : 'solicitudes',
    detalle: detalle,
    admin: 'Moventi',
    fecha: fmtDateShort(today)
  };
  var subject = renderTemplate(settings.emailSubjectTemplate || DEFAULT_SUBJECT, vars);
  var text = renderTemplate(settings.emailBodyTemplate || DEFAULT_BODY, vars);
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px">' +
    renderTemplateHtml(settings.emailBodyTemplate || DEFAULT_BODY, vars, { detalle: detalleHtml }) + '</div>';

  var sendData;
  try {
    sendData = await sendGmail({ to: ingramEmail, cc: ccList.join(', '), subject: subject, text: text, html: html });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'send_failed', detail: String(err && err.detail || err && err.message || err), pending: due.length });
    return;
  }

  var nowIso = new Date().toISOString();
  var ids = due.map(function (r) { return r.id; });
  state.requests.forEach(function (r) {
    if (ids.indexOf(r.id) > -1) {
      r.notifiedToIngram = true;
      r.notifiedAt = nowIso;
      r.notifiedBy = 'Envío programado';
      r.scheduledSentAt = nowIso;
    }
  });
  try {
    await saveAppState(state);
  } catch (err) {
    // El correo ya salió: lo reportamos para no reintentar a ciegas mañana.
    res.status(500).json({ ok: true, sent: due.length, warning: 'state_save_failed', detail: String(err && err.message || err) });
    return;
  }

  // Copia de aviso interna (no va a Ingram).
  var avisoTo = INTERNAL_NOTIFY_EMAILS.slice();
  if (Array.isArray(settings.notifyEmails)) {
    settings.notifyEmails.forEach(function (n) { if (n && n.email) avisoTo.push(String(n.email).trim()); });
  }
  avisoTo = avisoTo.filter(function (e, i, a) { return e && a.indexOf(e) === i; });
  if (avisoTo.length) {
    try {
      await sendGmail({
        to: avisoTo.join(', '),
        subject: 'Envío programado realizado — ' + due.length + ' solicitud' + (due.length === 1 ? '' : 'es'),
        text: 'Se enviaron automáticamente a ' + ingramEmail + ' las siguientes solicitudes programadas para hoy (' + fmtDateShort(today) + '):\n\n' + detalle,
        html: '<div style="font-family:Arial,sans-serif;font-size:14px">Se enviaron automáticamente a <strong>' + esc(ingramEmail) +
          '</strong> las siguientes solicitudes programadas para hoy (' + fmtDateShort(today) + '):' + detalleHtml + '</div>'
      });
    } catch (e) { /* el envío principal ya se hizo; el aviso es secundario */ }
  }

  res.status(200).json({ ok: true, sent: due.length, today: today, messageId: sendData && sendData.messageId, to: ingramEmail });
};
