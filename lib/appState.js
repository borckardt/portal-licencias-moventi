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

const { put, list, del } = require('@vercel/blob');

// Vercel Blob sirve sus URLs públicas detrás de un CDN que las trata como
// inmutables: sobrescribir el mismo pathname (allowOverwrite) y releerlo
// enseguida puede devolver la copia vieja cacheada de forma indefinida, no
// solo unos segundos — ni el query-string cache-busting ni cache:'no-store'
// lo evitan (verificado en vivo: 0/5 lecturas inmediatas tras un guardado
// devolvieron el valor nuevo). Por eso cada guardado escribe a un pathname
// nuevo y único (nunca visto por el CDN) y borra los anteriores después.
const BLOB_PREFIX = 'app-state';

async function loadAppState() {
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
async function saveAppState(data) {
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

module.exports = { loadAppState, saveAppState };
