// /api/pin — the Security PIN lives on the server.
//   POST { action: 'status' }                      -> { ok, hasPin, locked, retryAfterSec }
//   POST { action: 'verify', pin }                 -> 200 ok | 401 wrong pin | 423 locked
//   POST { action: 'set', newPin, pin? }           -> sets the PIN (current PIN required when one exists)
//   POST { action: 'remove', pin }                 -> removes the PIN (current PIN required)
// Needs in Vercel → Environment Variables:  FIREBASE_SERVICE_ACCOUNT  (same as withdraw / send-gift)
const { verifyFirebaseIdToken } = require('../lib/verify-firebase-token');
const pinLib = require('../lib/pin');

let cachedAdmin = null;
function realAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  cachedAdmin = { db: getFirestore(), FieldValue };
  return cachedAdmin;
}

// Turns a checkPin() result into an HTTP answer. Returns true when the PIN was accepted.
function answer(res, c) {
  if (c.state === 'ok') return true;
  if (c.state === 'none') { res.status(409).json({ error: 'no pin set' }); return false; }
  if (c.state === 'bad') { res.status(400).json({ error: 'bad pin' }); return false; }
  if (c.state === 'locked') { res.status(423).json({ error: 'locked', retryAfterSec: c.retryAfterSec }); return false; }
  res.status(401).json({ error: 'wrong pin', attemptsLeft: c.attemptsLeft });
  return false;
}

function makeHandler(deps = {}) {
  const verify = deps.verify || verifyFirebaseIdToken;
  const getAdmin = deps.getAdmin || realAdmin;

  return async function handler(req, res) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

      const auth = req.headers.authorization || '';
      let claims;
      try { claims = await verify(auth.startsWith('Bearer ') ? auth.slice(7) : ''); }
      catch (e) { res.status(401).json({ error: 'sign-in required' }); return; }
      const uid = claims.sub;

      const body = req.body || {};
      const action = String(body.action || '');
      const { db, FieldValue } = getAdmin();

      if (action === 'status') {
        const st = await pinLib.pinStatus(db, FieldValue, uid);
        res.status(200).json({ ok: true, ...st });
        return;
      }

      if (action === 'verify') {
        const c = await pinLib.checkPin(db, FieldValue, uid, body.pin);
        if (c.state === 'none') { res.status(200).json({ ok: true, noPin: true }); return; }
        if (answer(res, c)) res.status(200).json({ ok: true });
        return;
      }

      if (action === 'set') {
        if (!pinLib.PIN_RE.test(String(body.newPin == null ? '' : body.newPin))) { res.status(400).json({ error: 'bad new pin' }); return; }
        const st = await pinLib.pinStatus(db, FieldValue, uid);
        if (st.hasPin) {
          if (body.pin == null || body.pin === '') { res.status(401).json({ error: 'pin required' }); return; }
          const c = await pinLib.checkPin(db, FieldValue, uid, body.pin);
          if (!answer(res, c)) return;
        }
        await pinLib.setPin(db, FieldValue, uid, String(body.newPin));
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'remove') {
        if (body.pin == null || body.pin === '') { res.status(401).json({ error: 'pin required' }); return; }
        const c = await pinLib.checkPin(db, FieldValue, uid, body.pin);
        if (c.state === 'none') { res.status(200).json({ ok: true, noPin: true }); return; }
        if (!answer(res, c)) return;
        await pinLib.removePin(db, FieldValue, uid);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'unknown action' });
    } catch (err) {
      console.error('pin error:', String((err && err.message) || err));
      res.status(500).json({ error: 'pin failed' });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
