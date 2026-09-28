// Almacén de documentos JSON del portal (estado compartido y cuenta admin),
// con tres "drivers" intercambiables por variable de entorno, para que el
// mismo código corra en Vercel, en AWS o en local:
//
//   STORAGE_DRIVER=s3    → Amazon S3 (despliegue en AWS). Requiere S3_BUCKET
//                          y AWS_REGION; opcional S3_PREFIX (ej. "portal/").
//                          Credenciales: las del rol IAM de la instancia /
//                          servicio (recomendado) o AWS_ACCESS_KEY_ID/SECRET.
//   STORAGE_DRIVER=blob  → Vercel Blob (lo que usa hoy producción en Vercel).
//                          Requiere BLOB_READ_WRITE_TOKEN.
//   STORAGE_DRIVER=file  → archivos JSON en disco (DATA_DIR, por defecto
//                          ./data). Para trabajar en local sin tocar datos
//                          reales. NO usar en AWS con más de una instancia.
//
// Si STORAGE_DRIVER no está definido se elige solo: S3_BUCKET → s3;
// BLOB_READ_WRITE_TOKEN → blob; si no hay ninguno → file.
//
// Cada documento se identifica por un nombre ('app-state', 'admin-auth').

const fs = require('fs');
const path = require('path');

function driverName() {
  const explicit = String(process.env.STORAGE_DRIVER || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.S3_BUCKET) return 's3';
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob';
  return 'file';
}

/* ---------------- Vercel Blob ---------------- */
// Vercel Blob sirve sus URLs públicas detrás de un CDN que las trata como
// inmutables: sobrescribir el mismo pathname y releerlo enseguida puede
// devolver la copia vieja cacheada. Por eso cada guardado escribe a un
// pathname nuevo y único y borra los anteriores después (comportamiento
// idéntico al que tenía el portal antes de este archivo).
const blobDriver = {
  async load(name) {
    const { list } = require('@vercel/blob');
    const { blobs } = await list({ prefix: name });
    if (!blobs.length) return null;
    blobs.sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
    const res = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  },
  async save(name, data) {
    const { put, list, del } = require('@vercel/blob');
    const { blobs: staleBlobs } = await list({ prefix: name });
    const pathname = name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json';
    await put(pathname, JSON.stringify(data), { access: 'public', contentType: 'application/json' });
    await Promise.all(staleBlobs.map(function (b) { return del(b.url).catch(function () {}); }));
  },
};

/* ---------------- Amazon S3 ---------------- */
// S3 es consistente en lectura tras escritura, así que basta con una clave
// fija por documento. El bucket debe ser PRIVADO (Block Public Access
// activado): el portal lo lee y escribe solo desde el servidor.
let s3Client = null;
function s3() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });
  }
  return s3Client;
}
function s3Key(name) {
  return String(process.env.S3_PREFIX || '') + name + '.json';
}
const s3Driver = {
  async load(name) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const out = await s3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: s3Key(name) }));
      const text = await out.Body.transformToString('utf-8');
      return text ? JSON.parse(text) : null;
    } catch (err) {
      if (err && (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404))) return null;
      throw err;
    }
  },
  async save(name, data) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3().send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: s3Key(name),
      Body: JSON.stringify(data),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
  },
};

/* ---------------- Archivos locales ---------------- */
function dataDir() {
  return path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
}
const fileDriver = {
  async load(name) {
    const f = path.join(dataDir(), name + '.json');
    try {
      return JSON.parse(await fs.promises.readFile(f, 'utf-8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  },
  async save(name, data) {
    const dir = dataDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const f = path.join(dir, name + '.json');
    const tmp = f + '.' + process.pid + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(data));
    await fs.promises.rename(tmp, f); // escritura atómica
  },
};

const DRIVERS = { blob: blobDriver, s3: s3Driver, file: fileDriver };

function driver() {
  const name = driverName();
  const d = DRIVERS[name];
  if (!d) throw new Error('STORAGE_DRIVER desconocido: ' + name + ' (usa s3, blob o file)');
  if (name === 's3' && !process.env.S3_BUCKET) throw new Error('STORAGE_DRIVER=s3 requiere S3_BUCKET');
  return d;
}

async function loadDoc(name) { return driver().load(name); }
async function saveDoc(name, data) { return driver().save(name, data); }

// Solo para pruebas: permite inyectar un cliente S3 falso.
function _setS3Client(c) { s3Client = c; }

module.exports = { loadDoc, saveDoc, driverName, _drivers: DRIVERS, _setS3Client };
