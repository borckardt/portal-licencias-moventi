// Rate limiting "básico" para los endpoints de autenticación
// (verify-admin-login, request-password-reset, reset-password,
// change-admin-password), pensado para frenar fuerza bruta casual.
//
// LIMITACIÓN IMPORTANTE (léela antes de confiar en esto para más que eso):
// Vercel ejecuta cada función serverless en instancias efímeras — este
// contador vive solo en memoria del proceso, así que:
//   - se resetea en cada "cold start" (instancia nueva).
//   - NO se comparte entre regiones/instancias concurrentes si hay más de
//     una sirviendo tráfico a la vez.
// Es decir, esto sube el costo de un ataque automatizado casual, pero NO es
// una defensa robusta contra un atacante que reparte requests entre varias
// instancias a propósito. Para eso hace falta un contador compartido de
// verdad (p.ej. Vercel KV / Upstash Redis) — ver tareas.md.

const buckets = new Map(); // key -> [timestamps]

function getClientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Devuelve true si la petición está permitida (y registra el intento);
// false si se pasó del límite.
function allow(key, limit, windowMs) {
  var now = Date.now();
  var arr = buckets.get(key) || [];
  arr = arr.filter(function (t) { return now - t < windowMs; });
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

// Limpieza oportunista para no acumular memoria indefinidamente en una
// instancia de larga vida.
function sweep(maxAgeMs) {
  var now = Date.now();
  buckets.forEach(function (arr, key) {
    var kept = arr.filter(function (t) { return now - t < maxAgeMs; });
    if (kept.length) buckets.set(key, kept); else buckets.delete(key);
  });
}
if (Math.random() < 0.02) sweep(60 * 60 * 1000); // barrido ocasional, best-effort

module.exports = { allow, getClientIp };
