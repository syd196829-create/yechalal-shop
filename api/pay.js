// /api/pay — automatic payments through Chapa. One function, several actions (POST, signed-in users only):
//   { action:'config' }                    -> what is switched on
//   { action:'checkout', coins }           -> { checkoutUrl }   (send the person there to pay in birr)
//   { action:'confirm',  txRef }           -> asks Chapa; adds the coins once if the payment really happened
//   { action:'banks' }                     -> bank / mobile-money list for the payout form
//   { action:'sync' }                      -> finishes this person's payouts that are still "processing"
// Needs: FIREBASE_SERVICE_ACCOUNT, CHAPA_SECRET_KEY  (see lib/payments.js for all the options)
const { verifyFirebaseIdToken } = require('../lib/verify-firebase-token');
const { makeChapa } = require('../lib/chapa');
const payments = require('../lib/payments');

let cachedAdmin = null;
function realAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  cachedAdmin = { db: getFirestore(), FieldValue };
  return cachedAdmin;
}

let banksCache = { at: 0, list: null };
async function loadBanks(chapa) {
  if (banksCache.list && Date.now() - banksCache.at < 6 * 3600 * 1000) return banksCache.list;
  const r = await chapa.banks();
  const list = (Array.isArray(r && r.data) ? r.data : [])
    .filter((b) => b && b.id != null && b.name && b.is_active !== 0 && b.active !== 0 && (!b.currency || String(b.currency).toUpperCase() === 'ETB'))
    .map((b) => ({ id: b.id, name: String(b.name), len: b.acct_length || null, mobile: !!b.is_mobilemoney }))
    .sort((a, b) => a.name.localeCompare(b.name));
  banksCache = { at: Date.now(), list };
  return list;
}

function makeHandler(deps = {}) {
  const verify = deps.verify || verifyFirebaseIdToken;
  const getAdmin = deps.getAdmin || realAdmin;
  const getChapa = deps.getChapa || (() => makeChapa());
  const getCfg = deps.getCfg || (() => payments.config());

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
      const cfg = getCfg();

      if (action === 'config') {
        res.status(200).json({ ok: true, autoCoins: cfg.autoCoins, autoPayout: cfg.autoPayout, priceEtb: cfg.priceEtb,
          packages: payments.COIN_PACKAGES, maxAutoUsd: cfg.autoMaxUsd });
        return;
      }

      const { db, FieldValue } = getAdmin();
      const chapa = getChapa();

      if (action === 'checkout') {
        if (!cfg.autoCoins) { res.status(503).json({ error: 'automatic payment is not available yet' }); return; }
        if (!claims.email) { res.status(400).json({ error: 'an e-mail address is needed' }); return; }
        try {
          const out = await payments.createCheckout({ db, FieldValue, chapa, cfg, uid, email: claims.email, name: claims.name || '', coins: body.coins });
          res.status(200).json({ ok: true, ...out });
        } catch (e) {
          const m = String((e && e.message) || e);
          if (m === 'BAD_PACKAGE') { res.status(400).json({ error: 'bad package' }); return; }
          if (m === 'NO_SUPPLY') { res.status(409).json({ error: 'sold out' }); return; }
          console.error('checkout error:', m, e && e.body ? JSON.stringify(e.body).slice(0, 300) : '');
          res.status(502).json({ error: 'payment provider error' });
        }
        return;
      }

      if (action === 'confirm') {
        const txRef = String(body.txRef || '').slice(0, 80);
        const snap = txRef ? await db.collection('payments').doc(txRef).get() : null;
        if (!snap || !snap.exists || snap.data().uid !== uid) { res.status(404).json({ error: 'payment not found' }); return; }
        const r = await payments.settlePayment({ db, FieldValue, chapa, txRef });
        res.status(200).json({ ok: true, ...r });
        return;
      }

      if (action === 'banks') {
        if (!cfg.autoPayout || !chapa.configured) { res.status(200).json({ ok: true, banks: [] }); return; }
        try { res.status(200).json({ ok: true, banks: await loadBanks(chapa) }); }
        catch (e) { res.status(200).json({ ok: true, banks: [] }); }       // payout form falls back to the manual way
        return;
      }

      if (action === 'sync') {
        const q = await db.collection('withdrawRequests').where('uid', '==', uid).where('status', '==', 'processing').limit(5).get();
        const out = [];
        for (const d of q.docs) out.push({ id: d.id, ...(await payments.finalizeTransfer({ db, FieldValue, chapa, reference: d.id })) });
        res.status(200).json({ ok: true, results: out });
        return;
      }

      res.status(400).json({ error: 'unknown action' });
    } catch (err) {
      console.error('pay error:', String((err && err.message) || err));
      res.status(500).json({ error: 'pay failed' });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
