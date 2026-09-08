// Corre con: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkNonAdminSave } = require('../lib/appStateGuard');

function baseState() {
  return {
    users: [{ id: 'u1', username: 'acme', role: 'client' }],
    licenseTypes: [],
    settings: {},
    requests: [{ id: 'r1', status: 'pendiente', clientUsername: 'acme' }],
  };
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

test('un cliente puede agregar su propia solicitud nueva en estado pendiente', () => {
  const prev = baseState();
  const next = clone(prev);
  next.requests.push({ id: 'r2', status: 'pendiente', clientUsername: 'acme' });
  assert.equal(checkNonAdminSave(prev, next).ok, true);
});

test('rechaza una solicitud nueva que ya viene "aprobada" (no es un envío legítimo de cliente)', () => {
  const prev = baseState();
  const next = clone(prev);
  next.requests.push({ id: 'r2', status: 'aprobado', clientUsername: 'acme' });
  assert.equal(checkNonAdminSave(prev, next).ok, false);
});

test('rechaza una solicitud nueva de un cliente que no existe en users', () => {
  const prev = baseState();
  const next = clone(prev);
  next.requests.push({ id: 'r2', status: 'pendiente', clientUsername: 'fantasma' });
  assert.equal(checkNonAdminSave(prev, next).ok, false);
});

test('rechaza modificar una solicitud existente sin sesión de admin', () => {
  const prev = baseState();
  const next = clone(prev);
  next.requests[0].status = 'aprobado';
  const result = checkNonAdminSave(prev, next);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'existing_request_modified');
});

test('rechaza eliminar una solicitud existente sin sesión de admin', () => {
  const prev = baseState();
  const next = clone(prev);
  next.requests = [];
  const result = checkNonAdminSave(prev, next);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'request_removed');
});

test('rechaza cualquier cambio a users, licenseTypes o settings', () => {
  const prev = baseState();

  const nextUsers = clone(prev);
  nextUsers.users.push({ id: 'u2', username: 'hacker', role: 'admin' });
  assert.equal(checkNonAdminSave(prev, nextUsers).ok, false);

  const nextTypes = clone(prev);
  nextTypes.licenseTypes.push({ id: 'lt-x', name: 'gratis', price: 0 });
  assert.equal(checkNonAdminSave(prev, nextTypes).ok, false);

  const nextSettings = clone(prev);
  nextSettings.settings.ingramEmail = 'atacante@evil.com';
  assert.equal(checkNonAdminSave(prev, nextSettings).ok, false);
});

test('sin estado previo (bootstrap), exige admin', () => {
  assert.equal(checkNonAdminSave(null, baseState()).ok, false);
});

test('un body inválido (no objeto) se rechaza', () => {
  assert.equal(checkNonAdminSave(baseState(), null).ok, false);
  assert.equal(checkNonAdminSave(baseState(), 'no-soy-un-objeto').ok, false);
});
