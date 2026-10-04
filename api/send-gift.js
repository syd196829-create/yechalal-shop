// /api/send-gift — the ONLY place where a gift moves money.
// The app asks; this server (not the phone) checks and does everything in one safe step:
//   viewer's coins  -N        (fails if the viewer does not have enough)
//   host's earnings +70% of the gift's dollar value   (the app keeps 30%)
//   a "liveGifts" record for the on-screen banner / history
// Needs in Vercel → Environment Variables:  FIREBASE_SERVICE_ACCOUNT  (the whole service-account JSON)
const { verifyFirebaseIdToken } = require('../lib/verify-firebase-token');

// Keep these two in step with the app (index.html: COIN_PRICE_USD, HOST_SHARE). Can be overridden in Vercel.
const COIN_PRICE_USD = parseFloat(process.env.COIN_PRICE_USD || '0.04');
const HOST_SHARE = parseFloat(process.env.HOST_SHARE || '0.70');
const GIFT_COSTS = [10, 50, 100, 200, 300, 500, 700, 1000];   // same list as the app's GIFT_CATALOG

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

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, max);

// `deps` is only for tests; in production the real Firebase Admin and token check are used.
function makeHandler(deps = {}) {
  const verify = deps.verify || verifyFirebaseIdToken;
  const getAdmin = deps.getAdmin || realAdmin;

  return async function handler(req, res) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

      // 1) who is sending?
      const auth = req.headers.authorization || '';
      let fromUid;
      try { fromUid = (await verify(auth.startsWith('Bearer ') ? auth.slice(7) : '')).sub; }
      catch (e) { res.status(401).json({ error: 'sign-in required' }); return; }

      // 2) is the request sane?
      const body = req.body || {};
      const cost = Number(body.cost);
      const toUid = clean(body.toUid, 128);
      if (!GIFT_COSTS.includes(cost)) { res.status(400).json({ error: 'invalid gift' }); return; }
      if (!toUid || toUid === fromUid) { res.status(400).json({ error: 'invalid receiver' }); return; }

      const { db, FieldValue } = getAdmin();
      const valueUsd = round6(cost * COIN_PRICE_USD);
      const hostUsd = round6(valueUsd * HOST_SHARE);
      const platformUsd = round6(valueUsd - hostUsd);

      // 3) one atomic step
      let newBalance = 0;
      await db.runTransaction(async (tx) => {
        const fromRef = db.collection('users').doc(fromUid);
        const toRef = db.collection('users').doc(toUid);
        const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
        if (!fromSnap.exists) throw new Error('NO_SENDER');
        if (!toSnap.exists) throw new Error('NO_RECEIVER');
        const coins = Number((fromSnap.data() || {}).coins || 0);
        if (coins < cost) throw new Error('INSUFFICIENT_COINS');
        newBalance = coins - cost;
        tx.update(fromRef, { coins: FieldValue.increment(-cost), fanPoints: FieldValue.increment(cost) });
        tx.update(toRef, { earningsUsd: FieldValue.increment(hostUsd) });
        tx.set(db.collection('liveGifts').doc(), {
          channelName: clean(body.channelName, 128),
          fromUid, fromName: clean(body.fromName, 80),
          toUid, toName: clean(body.toName, 80),
          emoji: clean(body.emoji, 16), cost,
          valueUsd, hostUsd, platformUsd,
          createdAt: FieldValue.serverTimestamp()
        });
      });

      res.status(200).json({ ok: true, coins: newBalance });
    } catch (err) {
      const m = String((err && err.message) || err);
      if (m.includes('INSUFFICIENT_COINS')) { res.status(402).json({ error: 'not enough coins' }); return; }
      if (m.includes('NO_RECEIVER') || m.includes('NO_SENDER')) { res.status(404).json({ error: 'user not found' }); return; }
      console.error('send-gift error:', m);
      res.status(500).json({ error: 'gift failed' });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;   // for tests
