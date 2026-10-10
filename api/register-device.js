// /api/register-device — records WHERE a signed-in device is (country / city / hidden IP) in
//   users/{uid}/devices/{deviceId}. The place is read by the server from Vercel's own request
//   headers, so the phone cannot make it up. Used by Settings → Devices.
// Needs in Vercel → Environment Variables:  FIREBASE_SERVICE_ACCOUNT  (same one /api/send-gift uses)
const { verifyFirebaseIdToken } = require('../lib/verify-firebase-token');

let cachedAdmin = null;
function realAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  cachedAdmin = { db: getFirestore(), FieldValue };
  return cachedAdmin;
}

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, max);
function decode(v) { try { return decodeURIComponent(String(v || '')); } catch (e) { return String(v || ''); } }
// show only part of the IP address (privacy): 197.156.x.x  /  2a00:1450::
function maskIp(ip) {
  ip = String(ip || '').split(',')[0].trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 2).join('.') + '.x.x';
  if (ip.includes(':')) return ip.split(':').slice(0, 2).join(':') + '::';
  return '';
}

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

      const deviceId = clean((req.body || {}).deviceId, 64);
      if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) { res.status(400).json({ error: 'bad device' }); return; }

      const h = req.headers;
      const geo = {
        country: clean(h['x-vercel-ip-country'], 2).toUpperCase(),
        region: clean(decode(h['x-vercel-ip-country-region']), 40),
        city: clean(decode(h['x-vercel-ip-city']), 60),
        ipMasked: maskIp(h['x-forwarded-for'] || h['x-real-ip'])
      };
      const { db, FieldValue } = getAdmin();
      await db.collection('users').doc(uid).collection('devices').doc(deviceId)
        .set(Object.assign({}, geo, { geoAt: FieldValue.serverTimestamp() }), { merge: true });
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('register-device error:', e);
      res.status(500).json({ error: 'server error' });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;   // for tests
module.exports.maskIp = maskIp;
