// Corre con: node --test test/
// Prueba lib/store.js sin red: driver de archivos real (en carpeta temporal),
// selección automática de driver y driver S3 con un cliente simulado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');

function withEnv(vars, fn) {
  const prev = {};
  Object.keys(vars).forEach(function (k) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; });
  return Promise.resolve().then(fn).finally(function () {
    Object.keys(prev).forEach(function (k) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; });
  });
}

test('selección automática: S3_BUCKET → s3, BLOB token → blob, nada → file', () => withEnv(
  { STORAGE_DRIVER: undefined, S3_BUCKET: undefined, BLOB_READ_WRITE_TOKEN: undefined }, () => {
    assert.equal(store.driverName(), 'file');
    process.env.BLOB_READ_WRITE_TOKEN = 'x';
    assert.equal(store.driverName(), 'blob');
    process.env.S3_BUCKET = 'b';
    assert.equal(store.driverName(), 's3');
    process.env.STORAGE_DRIVER = 'file';
    assert.equal(store.driverName(), 'file');
  }));

test('driver file: guarda y relee; documento inexistente devuelve null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-store-'));
  return withEnv({ STORAGE_DRIVER: 'file', DATA_DIR: dir }, async () => {
    assert.equal(await store.loadDoc('app-state'), null);
    await store.saveDoc('app-state', { users: [1, 2], requests: [] });
    assert.deepEqual(await store.loadDoc('app-state'), { users: [1, 2], requests: [] });
    assert.equal(fs.existsSync(path.join(dir, 'app-state.json')), true);
  });
});

test('driver s3: escribe en <prefijo><nombre>.json y relee; NoSuchKey → null', () => {
  const objects = {};
  store._setS3Client({
    send: async function (cmd) {
      const name = cmd.constructor.name, input = cmd.input;
      const key = input.Bucket + '/' + input.Key;
      if (name === 'PutObjectCommand') { objects[key] = input.Body; return {}; }
      if (name === 'GetObjectCommand') {
        if (!(key in objects)) { const e = new Error('nope'); e.name = 'NoSuchKey'; throw e; }
        return { Body: { transformToString: async () => objects[key] } };
      }
      throw new Error('comando inesperado ' + name);
    },
  });
  return withEnv({ STORAGE_DRIVER: 's3', S3_BUCKET: 'mi-bucket', S3_PREFIX: 'portal/', AWS_REGION: 'us-east-1' }, async () => {
    assert.equal(await store.loadDoc('admin-auth'), null);
    await store.saveDoc('admin-auth', { username: 'admin' });
    assert.ok('mi-bucket/portal/admin-auth.json' in objects);
    assert.deepEqual(await store.loadDoc('admin-auth'), { username: 'admin' });
  }).finally(() => store._setS3Client(null));
});

test('STORAGE_DRIVER=s3 sin S3_BUCKET da un error claro', () => withEnv(
  { STORAGE_DRIVER: 's3', S3_BUCKET: undefined }, async () => {
    await assert.rejects(store.loadDoc('app-state'), /S3_BUCKET/);
  }));
