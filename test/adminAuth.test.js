// Corre con: node --test test/
// No toca red ni Vercel Blob — solo la lógica pura de hashing/verificación.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hashPassword, verifyPassword, needsRehash } = require('../lib/adminAuth');

test('hashPassword produce el formato nuevo (scrypt) y verifyPassword lo acepta', async () => {
  const hash = await hashPassword('Sup3rSecreta!');
  assert.equal(hash.startsWith('scrypt:'), true);
  assert.equal(await verifyPassword('Sup3rSecreta!', hash), true);
  assert.equal(needsRehash(hash), false);
});

test('verifyPassword rechaza una contraseña incorrecta', async () => {
  const hash = await hashPassword('correcta');
  assert.equal(await verifyPassword('incorrecta', hash), false);
});

test('dos hashes de la misma contraseña son distintos (salt aleatorio)', async () => {
  const a = await hashPassword('misma-clave');
  const b = await hashPassword('misma-clave');
  assert.notEqual(a, b);
});

test('formato viejo (salt:sha256hex) todavía se puede verificar, y needsRehash lo marca', async () => {
  const salt = 'abc123';
  const digest = crypto.createHash('sha256').update(salt + ':' + 'oldpass').digest('hex');
  const legacy = salt + ':' + digest;
  assert.equal(await verifyPassword('oldpass', legacy), true);
  assert.equal(await verifyPassword('otra', legacy), false);
  assert.equal(needsRehash(legacy), true);
});

test('verifyPassword no explota con valores raros (null, vacío, basura)', async () => {
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'scrypt:solo-dos-partes'), false);
});
