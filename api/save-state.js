// Saves the shared portal state (clients, license types, requests,
// settings) to Vercel Blob. The client sends its full local state after
// merging in whatever changed remotely (see mergeCollection in index.html),
// so this endpoint just writes what it's given — it doesn't merge itself.

const { saveAppState } = require('../lib/appState');

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
  var body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ ok: false, error: 'invalid_body' });
    return;
  }
  try {
    await saveAppState(body);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
