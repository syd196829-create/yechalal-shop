// /api/chapa-webhook — Chapa tells us "a payment / payout changed". We do NOT trust the message itself:
// we check Chapa's signature AND ask Chapa again (lib/payments.js) before giving coins or marking a payout.
// In the Chapa dashboard (Settings -> Webhooks) set the URL to  https://<your-site>/api/chapa-webhook
// and type the same "secret hash" into the Vercel variable CHAPA_WEBHOOK_SECRET.
const { makeChapa, webhookSignatureOk } = require('../lib/chapa');
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
const safeParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return { raw: req.body, obj: safeParse(req.body) };
    if (Buffer.isBuffer(req.body)) { const raw = req.body.toString('utf8'); return { raw, obj: safeParse(raw) }; }
    return { raw: null, obj: req.body };
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return { raw, obj: safeParse(raw) };
}

function makeHandler(deps = {}) {
  const getAdmin = deps.getAdmin || realAdmin;
  const getChapa = deps.getChapa || (() => makeChapa());
  const getCfg = deps.getCfg || (() => payments.config());

  // Looks up what the reference belongs to and lets Chapa confirm it.
  async function process(ref) {
    ref = String(ref || '').slice(0, 80);
    if (!ref) return { state: 'ignored' };
    const { db, FieldValue } = getAdmin();
    const chapa = getChapa();
    if ((await db.collection('payments').doc(ref).get()).exists) return payments.settlePayment({ db, FieldValue, chapa, txRef: ref });
    if ((await db.collection('withdrawRequests').doc(ref).get()).exists) return payments.finalizeTransfer({ db, FieldValue, chapa, reference: ref });
    return { state: 'ignored' };
  }

  return async function handler(req, res) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      // Chapa's "callback_url" arrives as a GET with ?trx_ref=...  (nothing is believed: we ask Chapa again)
      if (req.method === 'GET') {
        const q = req.query || {};
        const r = await process(q.trx_ref || q.tx_ref || q.reference);
        res.status(200).json({ ok: true, ...r });
        return;
      }
      if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return; }

      const cfg = getCfg();
      if (!cfg.webhookSecret) { res.status(503).json({ error: 'webhook not configured' }); return; }
      const { raw, obj } = await readBody(req);
      const candidates = [raw, obj ? JSON.stringify(obj) : null];
      if (!webhookSignatureOk(candidates, req.headers || {}, cfg.webhookSecret)) { res.status(401).json({ error: 'bad signature' }); return; }
      const o = obj || {};
      const d = o.data && typeof o.data === 'object' ? o.data : {};
      const r = await process(o.tx_ref || o.reference || d.tx_ref || d.reference);
      res.status(200).json({ ok: true, ...r });
    } catch (err) {
      console.error('chapa webhook error:', String((err && err.message) || err));
      res.status(500).json({ error: 'webhook failed' });          // Chapa will retry
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.config = { api: { bodyParser: false } };           // we want the raw bytes to check the signature
