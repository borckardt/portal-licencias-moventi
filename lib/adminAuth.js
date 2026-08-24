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

const BLOB_PATHNAME = 'admin-auth.json';
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
  const { blobs } = await list({ prefix: BLOB_PATHNAME });
  if (!blobs.length) return null;
  blobs.sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
  const res = await fetch(blobs[0].url);
  if (!res.ok) return null;
  return res.json();
}

// Overwrites the stored auth doc. Vercel Blob doesn't let us reliably
// overwrite the same pathname across SDK versions, so instead we list the
// existing blob(s) for this pathname *before* writing the new one, then
// delete those old ones afterwards — the list taken before the write can
// only contain stale copies.
async function saveAuth(data) {
  const { blobs: staleBlobs } = await list({ prefix: BLOB_PATHNAME });
  await put(BLOB_PATHNAME, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
  });
  for (const b of staleBlobs) {
    try { await del(b.url); } catch (e) { /* best effort cleanup */ }
  }
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
