// lib/payments.js — AUTOMATIC coin purchases and AUTOMATIC payouts (through Chapa).
//
// COIN PURCHASE:  checkout -> person pays on Chapa -> we ASK CHAPA (never trust the phone / the webhook alone)
//                 -> coins are added ONCE, in a single transaction, together with the supply (Treasury) counter.
// PAYOUT:         withdrawal request (created by /api/withdraw, PIN checked) -> if it is small enough and safe,
//                 the money is sent automatically; otherwise it waits in the Admin "Withdraw" tab as before.
//
// Vercel variables (Settings -> Environment Variables):
//   CHAPA_SECRET_KEY            required (test key first)         SITE_URL   e.g. https://yechalal-shop.vercel.app
//   CHAPA_WEBHOOK_SECRET        the "secret hash" you type into the Chapa webhook settings (falls back to the key)
//   AUTO_COINS=false            optional: switch automatic coin purchase OFF
//   AUTO_PAYOUT=false           optional: switch automatic payout OFF
//   AUTO_PAYOUT_MAX_USD=50      one payout bigger than this waits for your approval      (default 50)
//   AUTO_PAYOUT_DAILY_USD=300   all automatic payouts together per day (Ethiopia time)   (default 300)
//   COIN_PRICE_ETB=5            birr per coin                                            (default 5, as in the app)
//   ETB_PER_USD=125             birr per dollar used for payouts (default = 5 birr / $0.04 per coin = 125)
const crypto = require('crypto');

const COIN_PACKAGES = [50, 100, 250, 500];
const COIN_PRICE_USD = 0.04;               // same number as the app (1 coin = $0.04)
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const flag = (v, d) => (v == null || v === '' ? d : String(v).toLowerCase() !== 'false');

function config(env = process.env) {
  const priceEtb = num(env.COIN_PRICE_ETB, 5);
  const hasKey = !!env.CHAPA_SECRET_KEY;
  return {
    hasKey,
    autoCoins: hasKey && flag(env.AUTO_COINS, true),
    autoPayout: hasKey && flag(env.AUTO_PAYOUT, true),
    autoMaxUsd: num(env.AUTO_PAYOUT_MAX_USD, 50),
    autoDailyUsd: num(env.AUTO_PAYOUT_DAILY_USD, 300),
    priceEtb,
    etbPerUsd: num(env.ETB_PER_USD, priceEtb / COIN_PRICE_USD),
    siteUrl: String(env.SITE_URL || 'https://yechalal-shop.vercel.app').replace(/\/+$/, ''),
    webhookSecret: env.CHAPA_WEBHOOK_SECRET || env.CHAPA_SECRET_KEY || ''
  };
}

const floor2 = (n) => Math.floor(n * 100 + 1e-9) / 100;
const eatDay = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);   // Ethiopia = UTC+3
const newTxRef = () => 'yc' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
const TREASURY = (db) => db.collection('coinTreasury').doc('main');

// ---------------------------------------------------------------- coin purchase
async function createCheckout({ db, FieldValue, chapa, cfg, uid, email, name, coins }) {
  coins = Number(coins);
  if (!COIN_PACKAGES.includes(coins)) throw new Error('BAD_PACKAGE');
  const t = await TREASURY(db).get();
  const td = t.exists ? t.data() : null;
  const left = td ? (td.allocated || 0) - (td.sold || 0) - (td.granted || 0) : 0;
  if (left < coins) throw new Error('NO_SUPPLY');
  const amountEtb = coins * cfg.priceEtb;
  const txRef = newTxRef();
  await db.collection('payments').doc(txRef).set({
    uid, coins, amountEtb, priceUsd: Math.round(coins * COIN_PRICE_USD * 100) / 100,
    status: 'pending', provider: 'chapa', createdAt: FieldValue.serverTimestamp()
  });
  const first = String(name || '').trim().split(/\s+/)[0] || 'Customer';
  const res = await chapa.initialize({
    amount: String(amountEtb), currency: 'ETB', email, first_name: first.slice(0, 30), tx_ref: txRef,
    callback_url: cfg.siteUrl + '/api/chapa-webhook', return_url: cfg.siteUrl + '/?pay=' + txRef
  });
  const url = res && res.data && res.data.checkout_url;
  if (!url) {
    await db.collection('payments').doc(txRef).update({ status: 'failed', note: 'no checkout url' });
    throw new Error('NO_CHECKOUT_URL');
  }
  return { txRef, checkoutUrl: url, amountEtb };
}

// Asks Chapa whether txRef is really paid; if yes adds the coins exactly once.
// Safe to call as often as you like (webhook, return page, retries).
async function settlePayment({ db, FieldValue, chapa, txRef }) {
  const ref = db.collection('payments').doc(String(txRef));
  const snap = await ref.get();
  if (!snap.exists) return { state: 'unknown' };
  const p = snap.data();
  if (p.status === 'paid') return { state: 'paid', coins: p.coins };

  let v;
  try { v = await chapa.verify(txRef); } catch (e) { return { state: 'pending' }; }   // not paid yet / not found
  const d = (v && v.data) || {};
  const st = String(d.status || '').toLowerCase();
  if (st !== 'success') {
    if (st === 'failed' || st === 'cancelled') {
      if (p.status === 'pending') await ref.update({ status: 'failed' });
      return { state: 'failed' };
    }
    return { state: 'pending' };
  }
  // What Chapa says was paid must match what we asked for.
  if (String(d.currency || '').toUpperCase() !== 'ETB' || !(Number(d.amount) + 1e-6 >= p.amountEtb)) {
    await ref.update({ status: 'mismatch', providerAmount: d.amount == null ? null : d.amount, providerCurrency: d.currency || null });
    return { state: 'mismatch' };
  }
  const userRef = db.collection('users').doc(p.uid);
  const trRef = TREASURY(db);
  const day = eatDay();
  return db.runTransaction(async (tx) => {
    const [ps, ts] = await Promise.all([tx.get(ref), tx.get(trRef)]);
    const cur = ps.data();
    if (cur.status === 'paid') return { state: 'paid', coins: cur.coins };
    const t = ts.exists ? ts.data() : null;
    const left = t ? (t.allocated || 0) - (t.sold || 0) - (t.granted || 0) : 0;
    if (left < cur.coins) { tx.update(ref, { status: 'paid_no_supply', paidAt: FieldValue.serverTimestamp() }); return { state: 'no_supply' }; }
    tx.update(userRef, { coins: FieldValue.increment(cur.coins) });
    tx.update(ref, { status: 'paid', paidAt: FieldValue.serverTimestamp(), providerRef: d.reference || null });
    tx.update(trRef, { sold: FieldValue.increment(cur.coins), ['soldByDay.' + day]: FieldValue.increment(cur.coins) });
    return { state: 'paid', coins: cur.coins };
  });
}

// ---------------------------------------------------------------- payout
// Called right after /api/withdraw created a "pending" request. Never throws.
async function tryAutoPayout({ db, FieldValue, chapa, cfg, requestId }) {
  try {
    if (!cfg.autoPayout || !chapa.configured) return { state: 'manual', why: 'off' };
    const ref = db.collection('withdrawRequests').doc(requestId);
    const dayRef = db.collection('payoutStats').doc(eatDay());
    const claim = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return { ok: false, why: 'missing' };
      const r = s.data();
      if (r.status !== 'pending') return { ok: false, why: 'not pending' };
      const pay = r.payout;
      if (!pay || !pay.bankCode || !pay.accountNumber || !pay.accountName) return { ok: false, why: 'no structured details' };
      if (!(r.amountUsd <= cfg.autoMaxUsd)) return { ok: false, why: 'above the automatic limit' };
      const ds = await tx.get(dayRef);
      const used = ds.exists ? Number(ds.data().totalUsd || 0) : 0;
      if (used + r.amountUsd > cfg.autoDailyUsd) return { ok: false, why: 'daily limit reached' };
      tx.set(dayRef, { totalUsd: FieldValue.increment(r.amountUsd) }, { merge: true });
      tx.update(ref, { status: 'processing', processingAt: FieldValue.serverTimestamp() });
      return { ok: true, r, etb: floor2(r.amountUsd * cfg.etbPerUsd) };
    });
    if (!claim.ok) return { state: 'manual', why: claim.why };

    const pay = claim.r.payout;
    try {
      const resp = await chapa.transfer({
        account_name: pay.accountName, account_number: String(pay.accountNumber), amount: String(claim.etb),
        currency: 'ETB', reference: requestId, bank_code: pay.bankCode
      });
      if (!resp || String(resp.status || '').toLowerCase() !== 'success') { const e = new Error('TRANSFER_REJECTED'); e.definite = true; throw e; }
      await ref.update({ payoutEtb: claim.etb, chapaTransferRef: requestId });
      return { state: 'processing' };
    } catch (e) {
      const definite = !!e.definite || (e.status >= 400 && e.status < 500);
      if (!definite) {          // network trouble: the money MAY have left -> stay "processing", settle later by asking Chapa
        await ref.update({ autoError: 'unclear: ' + String(e.message || e).slice(0, 100) }).catch(() => {});
        return { state: 'processing' };
      }
      await db.runTransaction(async (tx) => {   // clearly refused (e.g. Chapa balance too low): back to YOUR manual queue
        const s = await tx.get(ref);
        if (s.exists && s.data().status === 'processing') {
          tx.update(ref, { status: 'pending', autoError: String(e.message || e).slice(0, 100) });
          tx.set(dayRef, { totalUsd: FieldValue.increment(-claim.r.amountUsd) }, { merge: true });
        }
      });
      return { state: 'manual', why: 'transfer refused' };
    }
  } catch (err) {
    console.error('auto payout error:', String((err && err.message) || err));
    return { state: 'manual', why: 'error' };
  }
}

// Asks Chapa how a payout ended. success -> paid. failed -> the money goes back to the person's earnings.
async function finalizeTransfer({ db, FieldValue, chapa, reference }) {
  const ref = db.collection('withdrawRequests').doc(String(reference));
  const snap = await ref.get();
  if (!snap.exists) return { state: 'unknown' };
  const r0 = snap.data();
  if (r0.status !== 'processing') return { state: r0.status };
  let v;
  try { v = await chapa.verifyTransfer(reference); } catch (e) { return { state: 'processing' }; }
  const st = String((v && v.data && v.data.status) || '').toLowerCase();
  if (st === 'success') {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists && s.data().status === 'processing') tx.update(ref, { status: 'paid', paidAt: FieldValue.serverTimestamp(), paidBy: 'auto' });
    });
    return { state: 'paid' };
  }
  if (st === 'failed' || st === 'reversed' || st === 'cancelled') {
    const dayRef = db.collection('payoutStats').doc(eatDay());
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || s.data().status !== 'processing') return;
      const r = s.data();
      tx.update(db.collection('users').doc(r.uid), { earningsUsd: FieldValue.increment(r.amountUsd) });
      tx.update(ref, { status: 'failed', failedAt: FieldValue.serverTimestamp(), failReason: st });
      tx.set(dayRef, { totalUsd: FieldValue.increment(-r.amountUsd) }, { merge: true });
    });
    return { state: 'failed' };
  }
  return { state: 'processing' };
}

module.exports = { COIN_PACKAGES, config, createCheckout, settlePayment, tryAutoPayout, finalizeTransfer, floor2, eatDay };
