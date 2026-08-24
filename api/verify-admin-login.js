// Verifies the admin's username/password against the persistent store
// (Vercel Blob), so the admin account survives across browsers/devices and
// password resets actually work. Client accounts are unaffected — they
// still live in each browser's localStorage as before.

const { getOrCreateAuth, verifyPassword } = require('../lib/adminAuth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (process.env.PORTAL_API_TOKEN) {
    var provided = req.headers['x-portal-token'];
    if (provided !== process.env.PORTAL_API_TOKEN) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  var body = req.body || {};
  var username = (body.username || '').trim();
  var password = body.password || '';
  if (!username || !password) {
    res.status(400).json({ ok: false, error: 'missing_fields' });
    return;
  }

  try {
    var auth = await getOrCreateAuth();
    var ok = username === auth.username && verifyPassword(password, auth.passwordHash);
    res.status(200).json({ ok: ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
