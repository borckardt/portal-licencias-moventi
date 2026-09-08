// Sesión real de administrador, con firma HMAC del lado del servidor.
//
// Antes de esto, "estar logueado como admin" era puramente un estado del
// navegador (sessionStorage) — los endpoints que sí importan (guardar todo
// el estado, cambiar la contraseña del admin) solo comprobaban el
// PORTAL_API_TOKEN, que es público (vive en el HTML/JS que cualquiera puede
// leer con "ver código fuente"). Eso significa que, sin esto, cualquiera con
// ese token podía llamar a esos endpoints directamente sin loguearse nunca.
//
// Esta sesión se emite en api/verify-admin-login.js como una cookie
// HttpOnly (inalcanzable desde JS/XSS) y firmada (no se puede fabricar ni
// alterar sin conocer SESSION_SECRET, que solo vive en el servidor). El
// navegador la reenvía solo mismo-origen, así que las llamadas normales del
// panel de admin (fetch relativos a /api/...) la incluyen automáticamente
// sin cambiar nada en app.js.
//
// Requiere la variable de entorno SESSION_SECRET (ver README/SETUP_GMAIL.md).
// A propósito NO cae en ningún valor por defecto ni reusa PORTAL_API_TOKEN:
// como PORTAL_API_TOKEN es público, firmar con él anularía por completo la
// protección (cualquiera podría fabricar su propia cookie válida).

const crypto = require('crypto');

const COOKIE_NAME = 'moventi_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas

function getSecret() {
  var secret = process.env.SESSION_SECRET;
  if (!secret) {
    var err = new Error('missing_session_secret');
    err.code = 'missing_session_secret';
    throw err;
  }
  return secret;
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

// token = base64url(json):firma
function createSessionToken(username) {
  var payload = JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS });
  var body = Buffer.from(payload, 'utf-8').toString('base64url');
  return body + '.' + sign(body);
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  var body = parts[0], sig = parts[1];
  var expected = sign(body);
  // Comparación en tiempo constante para no filtrar la firma esperada por
  // temporización.
  var a = Buffer.from(sig);
  var b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    var payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.u || !payload.exp || Date.now() > payload.exp) return null;
  return { username: payload.u };
}

function parseCookies(req) {
  var header = req.headers && req.headers.cookie;
  var out = {};
  if (!header) return out;
  header.split(';').forEach(function (part) {
    var idx = part.indexOf('=');
    if (idx === -1) return;
    var k = part.slice(0, idx).trim();
    var v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// Devuelve { username } si la petición trae una cookie de sesión de admin
// válida y vigente, o null si no (falta, expiró, o SESSION_SECRET no está
// configurado — falla cerrado, nunca abierto).
function getAdminSession(req) {
  try {
    var cookies = parseCookies(req);
    return verifySessionToken(cookies[COOKIE_NAME]);
  } catch (e) {
    return null; // p.ej. missing_session_secret: sin sesión válida posible.
  }
}

function setSessionCookie(res, username) {
  var token = createSessionToken(username);
  var maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Max-Age=' + maxAgeSec +
    '; Path=/; HttpOnly; Secure; SameSite=Strict');
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict');
}

module.exports = { getAdminSession, setSessionCookie, clearSessionCookie, COOKIE_NAME };
