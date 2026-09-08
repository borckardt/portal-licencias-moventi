// Valida qué le está permitido guardar en /api/save-state a quien NO tiene
// una sesión de admin válida (ver lib/adminSession.js).
//
// El endpoint guarda el estado compartido completo (clientes, tipos de
// licencia, solicitudes, configuración) de una sola vez — app.js siempre
// manda el objeto entero, ya fusionado (ver mergeCollection en app.js). No
// hay forma de saber "qué cambió" solo mirando la forma del body, así que
// esto compara contra lo último guardado (prevState) para permitir
// exactamente lo que un cliente legítimo puede hacer desde su pantalla:
// agregar una solicitud nueva propia, en estado "pendiente". Todo lo demás
// (usuarios, tipos de licencia, configuración, o tocar una solicitud ya
// existente) requiere sesión de admin.
//
// Si esto alguna vez te bloquea un flujo legítimo de cliente que no sea
// "crear una solicitud nueva", es porque ese flujo cambió y esta lista de
// excepciones quedó corta — amplíala a propósito, no la borres.

function sameJson(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function looksLikeFreshClientRequest(req, users) {
  if (!req || typeof req !== 'object') return false;
  if (req.status !== 'pendiente') return false;
  if (req.reviewedBy || req.reviewedAt) return false;
  if (req.notifiedToIngram || req.notifiedAt || req.notifiedBy) return false;
  return (users || []).some(function (u) {
    return u && u.role === 'client' && u.username === req.clientUsername;
  });
}

// Devuelve { ok: true } o { ok: false, reason: '...' }.
function checkNonAdminSave(prevState, nextState) {
  if (!nextState || typeof nextState !== 'object') return { ok: false, reason: 'invalid_body' };

  // Todavía no hay nada guardado: tratamos la inicialización del estado
  // compartido (quién es el primer admin, qué tipos de licencia existen,
  // etc.) como una acción sensible que solo un admin debe poder hacer.
  if (!prevState) return { ok: false, reason: 'bootstrap_requires_admin' };

  if (!sameJson(prevState.users, nextState.users)) return { ok: false, reason: 'users_changed' };
  if (!sameJson(prevState.licenseTypes, nextState.licenseTypes)) return { ok: false, reason: 'licenseTypes_changed' };
  if (!sameJson(prevState.settings, nextState.settings)) return { ok: false, reason: 'settings_changed' };

  var prevRequests = Array.isArray(prevState.requests) ? prevState.requests : [];
  var nextRequests = Array.isArray(nextState.requests) ? nextState.requests : [];
  var prevById = {};
  prevRequests.forEach(function (r) { if (r && r.id != null) prevById[r.id] = r; });

  var seen = 0;
  for (var i = 0; i < nextRequests.length; i++) {
    var r = nextRequests[i];
    if (r && prevById.hasOwnProperty(r.id)) {
      seen++;
      if (!sameJson(r, prevById[r.id])) return { ok: false, reason: 'existing_request_modified' };
    } else if (!looksLikeFreshClientRequest(r, nextState.users)) {
      return { ok: false, reason: 'invalid_new_request' };
    }
  }
  // Si falta alguna solicitud que sí existía antes, alguien la borró — solo
  // un admin puede eliminar solicitudes.
  if (seen !== Object.keys(prevById).length) return { ok: false, reason: 'request_removed' };

  return { ok: true };
}

module.exports = { checkNonAdminSave };
