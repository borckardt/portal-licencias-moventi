// Persistent store for the portal's shared application data (clients,
// license types, requests, settings) — backed by Vercel Blob. Before this,
// all of that data lived only in each browser's localStorage, which meant a
// client account created on one computer simply didn't exist on another
// (login would fail with "usuario o contraseña incorrectos" even with the
// right credentials). This makes the whole dataset visible from any
// browser/device, for both admins and clients.
//
// Requires the project's Blob store to be connected (Vercel → Storage →
// Blob), which auto-adds the BLOB_READ_WRITE_TOKEN environment variable.

const { put, list } = require('@vercel/blob');

const BLOB_PATHNAME = 'app-state.json';

async function loadAppState() {
  const { blobs } = await list({ prefix: BLOB_PATHNAME });
  if (!blobs.length) return null;
  blobs.sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
  // Los blobs públicos de Vercel se sirven detrás de un CDN: leer la misma
  // URL justo después de sobrescribirla (allowOverwrite) puede devolver una
  // copia cacheada vieja durante unos segundos (esto explicaba, por ejemplo,
  // que una solicitud recién eliminada pareciera "resucitar" al releer el
  // estado enseguida). Rompemos el caché con un query param único +
  // cache:'no-store'.
  const bustUrl = blobs[0].url + (blobs[0].url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
  const res = await fetch(bustUrl, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

// Overwrites the stored state doc in place (allowOverwrite lets @vercel/blob
// write to the exact same pathname, no random suffix — see lib/adminAuth.js
// for why we don't list-then-delete "stale" copies here: with an in-place
// overwrite there never are any).
async function saveAppState(data) {
  await put(BLOB_PATHNAME, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
  });
}

module.exports = { loadAppState, saveAppState };
