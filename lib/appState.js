// Persistent store for the portal's shared application data (clients,
// license types, requests, settings). Before this, all of that data lived
// only in each browser's localStorage, which meant a client account created
// on one computer simply didn't exist on another. This makes the whole
// dataset visible from any browser/device, for both admins and clients.
//
// Dónde se guarda depende de STORAGE_DRIVER (ver lib/store.js): Vercel Blob
// en Vercel, Amazon S3 en AWS, o un archivo local para desarrollo.

const { loadDoc, saveDoc } = require('./store');

const DOC_NAME = 'app-state';

async function loadAppState() {
  return loadDoc(DOC_NAME);
}

async function saveAppState(data) {
  return saveDoc(DOC_NAME, data);
}

module.exports = { loadAppState, saveAppState };
