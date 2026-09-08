// Corre con: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { allow, getClientIp } = require('../lib/rateLimit');

test('permite hasta el límite y bloquea el siguiente intento', () => {
  const key = 'suite:' + Math.random();
  assert.equal(allow(key, 3, 60000), true);
  assert.equal(allow(key, 3, 60000), true);
  assert.equal(allow(key, 3, 60000), true);
  assert.equal(allow(key, 3, 60000), false); // 4to intento, ya se pasó
});

test('claves distintas tienen contadores independientes', () => {
  const keyA = 'suite-a:' + Math.random();
  const keyB = 'suite-b:' + Math.random();
  assert.equal(allow(keyA, 1, 60000), true);
  assert.equal(allow(keyA, 1, 60000), false);
  assert.equal(allow(keyB, 1, 60000), true); // no le afecta lo de keyA
});

test('getClientIp usa x-forwarded-for si está presente', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: {} };
  assert.equal(getClientIp(req), '203.0.113.5');
});

test('getClientIp cae a socket.remoteAddress sin x-forwarded-for', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(getClientIp(req), '127.0.0.1');
});
