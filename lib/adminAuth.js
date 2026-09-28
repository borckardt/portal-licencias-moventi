// Persistent store for the admin account's credentials — this is what makes
// "olvidé mi contraseña" work from any browser or device.
//
// Dónde se guarda depende de STORAGE_DRIVER (ver lib/store.js): Vercel Blob
// en Vercel, Amazon S3 en AWS, o un archivo local para desarrollo.

const crypto = require('crypto');
const { promisify } = require('util');
const { loadDoc, saveDoc } = require('./store');
const scryptAsync = promisify(crypto.scrypt);

const DOC_NAME = 'admin-auth';
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'Moventi2026!';
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Formato nuevo: 'scrypt:saltHex:hashHex'. scrypt es deliberadamente lento
// (a diferencia de un solo SHA-256, que un atacante con la base de datos
// filtrada podría probar miles de millones de veces por segundo en una
// GPU) — es la función recomendada por OWASP cuando no se quiere sumar una
// dependencia externa como bcrypt/argon2, ya que Node la trae nativa.
async function hashPasswordScrypt(password, saltHex) {
  saltHex = saltHex || crypto.randomBytes(16).toString('hex');
  const digest = await scryptAsync(password, saltHex, 64);
  return 'scrypt:' + saltHex + ':' + digest.toString('hex');
}

// Formato viejo: 'saltHex:sha256Hex' (un solo hash SHA-256, sin
// fortalecimiento). Se mantiene solo para poder verificar contraseñas que
// ya estaban guardadas así antes de este cambio — hashPassword() (abajo) ya
// no genera hashes nuevos en este formato.
function hashPasswordLegacySha256(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
  return salt + ':' + digest;
}

// Punto de entrada usado al crear/cambiar la contraseña del admin — siempre
// produce el formato nuevo (scrypt).
async function hashPassword(password) {
  return hashPasswordScrypt(password);
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  if (stored.indexOf('scrypt:') === 0) {
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const candidate = await hashPasswordScrypt(password, parts[1]);
    return timingSafeEqualStr(candidate, stored);
  }
  if (stored.indexOf(':') !== -1) {
    const salt = stored.split(':')[0];
    return timingSafeEqualStr(hashPasswordLegacySha256(password, salt), stored);
  }
  return false;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// true si `stored` todavía está en el formato viejo (SHA-256 simple) y
// conviene volver a hashear con scrypt en el próximo login/cambio exitoso.
function needsRehash(stored) {
  return !!stored && stored.indexOf('scrypt:') !== 0;
}

async function loadAuth() {
  return loadDoc(DOC_NAME);
}

async function saveAuth(data) {
  return saveDoc(DOC_NAME, data);
}

async function getOrCreateAuth() {
  let auth = await loadAuth();
  if (!auth) {
    auth = {
      username: DEFAULT_USERNAME,
      passwordHash: await hashPassword(DEFAULT_PASSWORD),
      resetToken: null,
      resetTokenExpiresAt: null,
    };
    await saveAuth(auth);
  }
  return auth;
}

module.exports = {
  hashPassword,
  verifyPassword,
  needsRehash,
  loadAuth,
  saveAuth,
  getOrCreateAuth,
  RESET_TOKEN_TTL_MS,
};
