// Cierra la sesión de admin del lado del servidor (borra la cookie
// HttpOnly emitida en verify-admin-login.js). El "logout" del navegador
// (sessionStorage) no puede tocar esta cookie porque es HttpOnly a
// propósito — necesita este endpoint para limpiarla de verdad.

const { clearSessionCookie } = require('../lib/adminSession');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
};
