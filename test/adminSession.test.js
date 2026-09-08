// Corre con: node --test test/
process.env.SESSION_SECRET = 'test-secret-only-for-this-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAdminSession, setSessionCookie, clearSessionCookie } = require('../lib/adminSession');

function fakeRes() {
  var headers = {};
  return { setHeader: (k, v) => { headers[k] = v; }, _headers: headers };
}

test('setSessionCookie + getAdminSession: una cookie recién emitida es válida', () => {
  const res = fakeRes();
  setSessionCookie(res, 'admin');
  const cookiePair = res._headers['Set-Cookie'].split(';')[0];
  const session = getAdminSession({ headers: { cookie: cookiePair } });
  assert.ok(session);
  assert.equal(session.username, 'admin');
});

test('sin cookie no hay sesión', () => {
  assert.equal(getAdminSession({ headers: {} }), null);
  assert.equal(getAdminSession({ headers: { cookie: '' } }), null);
});

test('una cookie alterada (firma inválida) se rechaza', () => {
  const res = fakeRes();
  setSessionCookie(res, 'admin');
  const cookiePair = res._headers['Set-Cookie'].split(';')[0];
  const tampered = cookiePair.slice(0, -1) + (cookiePair.slice(-1) === 'A' ? 'B' : 'A');
  assert.equal(getAdminSession({ headers: { cookie: tampered } }), null);
});

test('sin SESSION_SECRET configurado, falla cerrado (nunca abierto)', () => {
  const prev = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    assert.throws(() => setSessionCookie(fakeRes(), 'admin'));
    assert.equal(getAdminSession({ headers: { cookie: 'moventi_admin_session=cualquier-cosa' } }), null);
  } finally {
    process.env.SESSION_SECRET = prev;
  }
});

test('clearSessionCookie pone Max-Age=0', () => {
  const res = fakeRes();
  clearSessionCookie(res);
  assert.match(res._headers['Set-Cookie'], /Max-Age=0/);
});
