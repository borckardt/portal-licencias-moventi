// Returns the shared portal state (clients, license types, requests,
// settings) stored in Vercel Blob, so every browser/device sees the same
// data instead of each one keeping its own local copy.

const { loadAppState } = require('../lib/appState');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
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
  try {
    var state = await loadAppState();
    res.status(200).json({ ok: true, state: state });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
};
