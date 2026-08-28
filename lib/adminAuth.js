// Persistent store for the admin account's credentials, backed by Vercel
// Blob — this is what makes "olvidé mi contraseña" work from any browser or
// device, unlike the rest of the app's data (requests, clients, license
// types) which still lives only in each browser's localStorage.
//
// Requires the project's Blob store to be connected (Vercel → Storage →
// Blob), which auto-adds the BLOB_READ_WRITE_TOKEN environment variable.
// See SETUP_GMAIL.md / SETUP_PASSWORD_RESET.md for details.

const crypto = require('crypto');
const { put, list, del } = require('@vercel/blob');

// Vercel Blob sirve sus URLs públicas detrás de un CDN que las trata como
// inmutables: sobrescribir el mismo pathname (allowOverwrite) y releerlo
// enseguida puede devolver la copia vieja cacheada de forma indefinida, no
// solo unos segundos — ni el query-string cache-busting ni cache:'no-store'
// lo evitan (verificado en vivo: 0/5 lecturas inmediatas tras un guardado
// devolvieron el valor nuevo). Por eso cada guardado escribe a un pathname
// nuevo y único (nunca visto por el CDN) y borra los anteriores después.
const BLOB_PREFIX = 'admin-auth';
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'Moventi2026!';
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
  return salt + ':' + digest;
}

function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  const salt = stored.split(':')[0];
  return hashPassword(password, salt) === stored;
}

async function loadAuth() {
  const { blobs } = await list({ prefix: BLOB_PREFIX });
  if (!blobs.length) return null;
  blobs.sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
  const res = await fetch(blobs[0].url, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

// Escribe el doc en un pathname nuevo y único (nunca antes servido por el
// CDN, así que nunca puede devolver una copia cacheada vieja), y solo
// después de que ese guardado nuevo tuvo éxito borra los blobs anteriores
// que existían ANTES de escribir el nuevo (capturados primero para no
// borrar por error el que acabamos de crear).
async function saveAuth(data) {
  const { blobs: staleBlobs } = await list({ prefix: BLOB_PREFIX });
  const pathname = BLOB_PREFIX + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json';
  await put(pathname, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
  });
  await Promise.all(staleBlobs.map(function (b) {
    return del(b.url).catch(function () {});
  }));
}

async function getOrCreateAuth() {
  let auth = await loadAuth();
  if (!auth) {
    auth = {
      username: DEFAULT_USERNAME,
      passwordHash: hashPassword(DEFAULT_PASSWORD),
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
  loadAuth,
  saveAuth,
  getOrCreateAuth,
  RESET_TOKEN_TTL_MS,
};
