// /api/withdraw — a person asks to take out the money they EARNED. Safe version:
//   • the server checks the balance (the phone can never write the balance itself)
//   • minimum $10 (MIN_WITHDRAW_USD), one open request at a time
//   • the Security PIN is checked here on the server (lib/pin.js); 5 wrong tries lock it for 15 minutes
//   • in ONE step: balance −amount  and  a "withdrawRequests" record (status "pending") is created
// The owner then pays by bank/Telebirr and taps "Paid" (or "Reject", which gives the money back) in the Admin page.
// Needs in Vercel → Environment Variables:  FIREBASE_SERVICE_ACCOUNT  (same as send-gift)
const { verifyFirebaseIdToken } = require('../lib/verify-firebase-token');
const pinLib = require('../lib/pin');

// Hard floor: nobody can ever withdraw less than $10, even if the Vercel variable is set lower by mistake.
const HARD_MIN_WITHDRAW_USD = 10;
const MIN_WITHDRAW_USD = Math.max(HARD_MIN_WITHDRAW_USD, parseFloat(process.env.MIN_WITHDRAW_USD || '10') || HARD_MIN_WITHDRAW_USD);
const MAX_WITHDRAW_USD = 100000;
// A PIN is required to withdraw. Set the Vercel variable REQUIRE_PIN_FOR_WITHDRAW=false only if you ever
// want people WITHOUT a PIN to withdraw (anyone who HAS a PIN must always enter it).
const REQUIRE_PIN = String(process.env.REQUIRE_PIN_FOR_WITHDRAW || 'true').toLowerCase() !== 'false';

let cachedAdmin = null;
function realAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  cachedAdmin = { db: getFirestore(), FieldValue };
  return cachedAdmin;
}
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

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
      if (claims.email && claims.email_verified === false) { res.status(403).json({ error: 'verify your email first' }); return; }

      const body = req.body || {};
      const raw = Number(body.amountUsd);
      if (!Number.isFinite(raw) || raw <= 0 || raw > MAX_WITHDRAW_USD) { res.status(400).json({ error: 'invalid amount' }); return; }
      const amount = Math.floor(raw * 100 + 1e-9) / 100;                 // whole cents, never more than asked
      if (amount < MIN_WITHDRAW_USD) { res.status(400).json({ error: 'below minimum', min: MIN_WITHDRAW_USD }); return; }
      const details = clean(body.details, 160);
      if (!details) { res.status(400).json({ error: 'payout details required' }); return; }

      const { db, FieldValue } = getAdmin();

      // --- Security PIN, verified on the server (the phone cannot skip this) ---
      const st = await pinLib.pinStatus(db, FieldValue, uid);
      if (!st.hasPin) {
        if (REQUIRE_PIN) { res.status(403).json({ error: 'pin not set' }); return; }
      } else {
        if (body.pin == null || body.pin === '') { res.status(401).json({ error: 'pin required' }); return; }
        const c = await pinLib.checkPin(db, FieldValue, uid, body.pin);
        if (c.state === 'bad') { res.status(400).json({ error: 'bad pin' }); return; }
        if (c.state === 'locked') { res.status(423).json({ error: 'locked', retryAfterSec: c.retryAfterSec }); return; }
        if (c.state === 'wrong') { res.status(401).json({ error: 'wrong pin', attemptsLeft: c.attemptsLeft }); return; }
        if (c.state !== 'ok') { res.status(403).json({ error: 'pin not set' }); return; }
      }

      let requestId = null;
      await db.runTransaction(async (tx) => {
        const userRef = db.collection('users').doc(uid);
        const openQ = db.collection('withdrawRequests').where('uid', '==', uid).where('status', '==', 'pending').limit(1);
        const [userSnap, openSnap] = await Promise.all([tx.get(userRef), tx.get(openQ)]);
        if (!userSnap.exists) throw new Error('NO_USER');
        if (!openSnap.empty) throw new Error('ALREADY_PENDING');
        const u = userSnap.data() || {};
        if (Number(u.earningsUsd || 0) + 1e-9 < amount) throw new Error('INSUFFICIENT');
        const reqRef = db.collection('withdrawRequests').doc();
        requestId = reqRef.id;
        tx.update(userRef, { earningsUsd: FieldValue.increment(-amount) });
        tx.set(reqRef, {
          uid, name: clean(u.name || claims.name || '', 80), email: clean(claims.email || '', 120),
          amountUsd: amount, details, status: 'pending', createdAt: FieldValue.serverTimestamp()
        });
      });

      res.status(200).json({ ok: true, requestId });
    } catch (err) {
      const m = String((err && err.message) || err);
      if (m.includes('INSUFFICIENT')) { res.status(402).json({ error: 'not enough earnings' }); return; }
      if (m.includes('ALREADY_PENDING')) { res.status(409).json({ error: 'you already have an open request' }); return; }
      if (m.includes('NO_USER')) { res.status(404).json({ error: 'user not found' }); return; }
      console.error('withdraw error:', m);
      res.status(500).json({ error: 'withdraw failed' });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
