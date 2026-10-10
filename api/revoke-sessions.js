// /api/revoke-sessions — "my account was hacked": sign this account out of EVERY device.
//   1) checks who is asking (their own sign-in token — nobody can do this for someone else)
//   2) Firebase: revokes all refresh tokens, so no device can stay signed in (a device that
//      already holds a valid token can keep working for up to ~1 hour, then it is out for good)
//   3) marks every device in users/{uid}/devices as revoked, so open apps sign out right away
// Needs in Vercel → Environment Variables:  FIREBASE_SERVICE_ACCOUNT  (same one /api/send-gift uses)
const { verifyFirebaseIdToken } = require('../lib/verify-firebase-token');

let cachedAdmin = null;
function realAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  cachedAdmin = { db: getFirestore(), FieldValue, auth: getAuth() };
  return cachedAdmin;
}

// `deps` is only for tests; in production the real Firebase Admin and token check are used.
function makeHandler(deps = {}) {
  const verify = deps.verify || verifyFirebaseIdToken;
  const getAdmin = deps.getAdmin || realAdmin;

  return async function handler(req, res) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

      const header = req.headers.authorization || '';
      let uid;
      try { uid = (await verify(header.startsWith('Bearer ') ? header.slice(7) : '')).sub; }
      catch (e) { res.status(401).json({ error: 'sign-in required' }); return; }
      if (!uid) { res.status(401).json({ error: 'sign-in required' }); return; }

      const { db, FieldValue, auth } = getAdmin();
      await auth.revokeRefreshTokens(uid);                       // the real lock-out

      const snap = await db.collection('users').doc(uid).collection('devices').get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.set(d.ref, { revoked: true, revokedAt: FieldValue.serverTimestamp() }, { merge: true }));
      batch.set(db.collection('users').doc(uid), { sessionsRevokedAt: FieldValue.serverTimestamp() }, { merge: true });
      await batch.commit();

      res.status(200).json({ ok: true, devices: snap.size });
    } catch (e) {
      console.error('revoke-sessions error:', e);
      res.status(500).json({ error: 'server error' });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;   // for tests
