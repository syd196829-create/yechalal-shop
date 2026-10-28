// /api/send-gift — the ONLY place where money moves (gifts AND Creator Plan purchases: body.action = plan-*).
// The app asks; this server (not the phone) checks and does everything in one safe step:
//   viewer's coins  -N        (fails if the viewer does not have enough)
//   host's earnings +60% of the gift's dollar value   (the app keeps 40%)
//   a "liveGifts" record for the on-screen banner / history
// Needs in Vercel → Environment Variables:  FIREBASE_SERVICE_ACCOUNT  (the whole service-account JSON)
const { verifyFirebaseIdToken } = require('../lib/verify-firebase-token');

// Keep these two in step with the app (index.html: COIN_PRICE_USD, HOST_SHARE). Can be overridden in Vercel.
const COIN_PRICE_USD = parseFloat(process.env.COIN_PRICE_USD || '0.04');
const HOST_SHARE = parseFloat(process.env.HOST_SHARE || '0.60');
const GIFT_COSTS = [10, 20, 30, 50, 60, 80, 100, 150, 200, 300, 400, 500, 600, 700, 800, 1000, 1500, 2000, 3000];   // same list as the app's GIFT_CATALOG (2000 = country flags)

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

// ---- Creator Plan (paid with Aito Kef coins, 100% to the app) -----------------------------------------
// Prices: $16 / month, $98.50 / 6 months, $199 / year. 1 coin = COIN_PRICE_USD, so the coin prices below.
// Keep these in step with the app (index.html: CP_PLANS). Can be overridden in Vercel (PLAN_M1_COINS ...).
const PLANS = {
  m1: { months: 1,  coins: parseInt(process.env.PLAN_M1_COINS || '400', 10),  usd: 16 },
  m6: { months: 6,  coins: parseInt(process.env.PLAN_M6_COINS || '2463', 10), usd: 98.5 },
  y1: { months: 12, coins: parseInt(process.env.PLAN_Y1_COINS || '4975', 10), usd: 199 }
};
const DAY_MS = 86400000;
const RENEW_GRACE_MS = 7 * DAY_MS;   // an expired plan is auto-renewed only within 7 days after it ended
function addMonths(ms, n) { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); }

// action: plan-buy {planId} | plan-sync (auto-renews when due, returns status) | plan-auto {on}
async function handlePlan(action, body, uid, getAdmin, res) {
  const { db, FieldValue } = getAdmin();
  const now = Date.now();
  const planRef = db.collection('creatorPlans').doc(uid);
  const userRef = db.collection('users').doc(uid);
  let extra = { fanSubOn: false, fanCount: 0 };
  const status = (p, coins) => Object.assign({
    ok: true, coins,
    planId: p.planId || null, expiresAt: p.expiresAt || 0,
    autoRenew: p.autoRenew !== false,
    active: !!(p.expiresAt && p.expiresAt > now),
    lapsed: !!(p.expiresAt && p.expiresAt <= now)
  }, extra);

  if (action === 'plan-auto') {
    const snap = await planRef.get();
    if (!snap.exists) { res.status(404).json({ error: 'no plan' }); return; }
    await planRef.update({ autoRenew: body.on === true, updatedAt: FieldValue.serverTimestamp() });
    res.status(200).json({ ok: true, autoRenew: body.on === true });
    return;
  }
  if (action !== 'plan-buy' && action !== 'plan-sync') { res.status(400).json({ error: 'unknown action' }); return; }

  let result;
  await db.runTransaction(async (tx) => {
    const [uSnap, pSnap] = await Promise.all([tx.get(userRef), tx.get(planRef)]);
    if (!uSnap.exists) throw new Error('NO_SENDER');
    let coins = Number((uSnap.data() || {}).coins || 0);
    const cur = pSnap.exists ? (pSnap.data() || {}) : {};
    extra = { fanSubOn: !!cur.fanSubEnabled, fanCount: ((uSnap.data() || {}).fanSubUids || []).length };

    const charge = (planId, kind, expiresAt) => {
      const plan = PLANS[planId];
      // planUntil is a public copy of the end date, so other people's apps can tell this creator is on the plan (read-only for them)
      tx.update(userRef, { coins: FieldValue.increment(-plan.coins), planUntil: expiresAt });
      tx.set(db.collection('planPurchases').doc(), {
        uid, planId, kind, coins: plan.coins, usd: plan.usd, expiresAt, createdAt: FieldValue.serverTimestamp()
      });
      coins -= plan.coins;
    };

    if (action === 'plan-buy') {
      const planId = clean(body.planId, 8);
      const plan = PLANS[planId];
      if (!plan) throw new Error('BAD_PLAN');
      if (coins < plan.coins) throw new Error('INSUFFICIENT_COINS');
      const stillActive = !!(cur.expiresAt && cur.expiresAt > now);
      const expiresAt = addMonths(stillActive ? cur.expiresAt : now, plan.months);   // buying again extends, never loses time
      const next = {
        planId, expiresAt, startedAt: stillActive ? (cur.startedAt || now) : now,
        autoRenew: pSnap.exists ? cur.autoRenew !== false : true,
        fanSubEnabled: !!cur.fanSubEnabled,
        updatedAt: FieldValue.serverTimestamp()
      };
      tx.set(planRef, next);
      charge(planId, 'buy', expiresAt);
      result = status(next, coins);
      return;
    }

    // plan-sync: renew automatically when the plan has ended (inside the grace window) and the wallet has enough coins
    const plan = PLANS[cur.planId];
    if (cur.expiresAt && cur.expiresAt <= now && plan && cur.autoRenew !== false
        && (now - cur.expiresAt) <= RENEW_GRACE_MS && coins >= plan.coins) {
      const expiresAt = addMonths(cur.expiresAt, plan.months);
      const next = Object.assign({}, cur, { expiresAt, updatedAt: FieldValue.serverTimestamp() });
      tx.set(planRef, next);
      charge(cur.planId, 'renew', expiresAt);
      result = status(next, coins);
      return;
    }
    result = status(cur, coins);
  });
  res.status(200).json(result);
}

// ---- Fan Subscription: a follower pays once (default $1 = 25 coins), is a subscriber for life; creator gets 50% ----
// Only creators with an active Creator Plan who switched it on can receive subscribers.
const FAN_SUB_COINS = parseInt(process.env.FAN_SUB_COINS || '25', 10);
const FAN_CREATOR_SHARE = parseFloat(process.env.FAN_CREATOR_SHARE || '0.5');   // creator 50% / app 50% (change in Vercel only)

// action: fan-enable {on} (creator) | fan-subscribe {creatorUid} (follower)
async function handleFan(action, body, uid, getAdmin, res) {
  const { db, FieldValue } = getAdmin();
  const now = Date.now();

  if (action === 'fan-enable') {
    const on = body.on === true;
    const planRef = db.collection('creatorPlans').doc(uid);
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (tx) => {
      const [pSnap, uSnap] = await Promise.all([tx.get(planRef), tx.get(userRef)]);
      const p = pSnap.exists ? (pSnap.data() || {}) : {};
      if (!uSnap.exists) throw new Error('NO_SENDER');
      if (on && !(p.expiresAt && p.expiresAt > now)) throw new Error('NOT_AVAILABLE');
      if (!pSnap.exists) return;                       // switching off with no plan: nothing to do
      tx.update(planRef, { fanSubEnabled: on, updatedAt: FieldValue.serverTimestamp() });
      tx.update(userRef, { fanSubOn: on });            // public copy so followers' apps can show the Subscribe button
    });
    res.status(200).json({ ok: true, fanSubOn: on });
    return;
  }

  if (action !== 'fan-subscribe') { res.status(400).json({ error: 'unknown action' }); return; }
  const creatorUid = clean(body.creatorUid, 128);
  if (!creatorUid || creatorUid === uid) { res.status(400).json({ error: 'invalid creator' }); return; }
  const fromRef = db.collection('users').doc(uid);
  const toRef = db.collection('users').doc(creatorUid);
  const planRef = db.collection('creatorPlans').doc(creatorUid);
  const subRef = db.collection('fanSubs').doc(uid + '_' + creatorUid);
  const creatorUsd = round6(FAN_SUB_COINS * COIN_PRICE_USD * FAN_CREATOR_SHARE);
  const valueUsd = round6(FAN_SUB_COINS * COIN_PRICE_USD);
  let newBalance = 0;
  await db.runTransaction(async (tx) => {
    const [fromSnap, toSnap, planSnap, subSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef), tx.get(planRef), tx.get(subRef)]);
    if (!fromSnap.exists) throw new Error('NO_SENDER');
    if (!toSnap.exists) throw new Error('NO_RECEIVER');
    if (subSnap.exists) throw new Error('ALREADY');
    const p = planSnap.exists ? (planSnap.data() || {}) : {};
    if (!(p.expiresAt && p.expiresAt > now && p.fanSubEnabled === true)) throw new Error('NOT_AVAILABLE');
    const coins = Number((fromSnap.data() || {}).coins || 0);
    if (coins < FAN_SUB_COINS) throw new Error('INSUFFICIENT_COINS');
    newBalance = coins - FAN_SUB_COINS;
    tx.update(fromRef, { coins: FieldValue.increment(-FAN_SUB_COINS) });
    tx.update(toRef, { earningsUsd: FieldValue.increment(creatorUsd), fanSubUids: FieldValue.arrayUnion(uid) });
    tx.set(subRef, {
      subscriberUid: uid, creatorUid, coins: FAN_SUB_COINS,
      valueUsd, creatorUsd, platformUsd: round6(valueUsd - creatorUsd),
      createdAt: FieldValue.serverTimestamp()
    });
  });
  res.status(200).json({ ok: true, coins: newBalance });
}

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
      if (body.action) {
        const act = String(body.action);
        if (act.startsWith('fan-')) await handleFan(act, body, fromUid, getAdmin, res);
        else await handlePlan(act, body, fromUid, getAdmin, res);
        return;
      }
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
        const liveRef = db.collection('liveStreams').doc(toUid);
        const [fromSnap, toSnap, liveSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef), tx.get(liveRef)]);
        if (!fromSnap.exists) throw new Error('NO_SENDER');
        if (!toSnap.exists) throw new Error('NO_RECEIVER');
        const coins = Number((fromSnap.data() || {}).coins || 0);
        if (coins < cost) throw new Error('INSUFFICIENT_COINS');
        newBalance = coins - cost;
        tx.update(fromRef, { coins: FieldValue.increment(-cost), fanPoints: FieldValue.increment(cost) });
        tx.update(toRef, { earningsUsd: FieldValue.increment(hostUsd) });
        // Running total of coins gifted in this live, shown at the top for everyone (also for late joiners).
        // Only updated when the host's live document exists, so a gift can never create a fake live.
        if (liveSnap.exists) tx.update(liveRef, { giftCoins: FieldValue.increment(cost) });
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
      if (m.includes('BAD_PLAN')) { res.status(400).json({ error: 'invalid plan' }); return; }
      if (m.includes('ALREADY')) { res.status(409).json({ error: 'already subscribed' }); return; }
      if (m.includes('NOT_AVAILABLE')) { res.status(403).json({ error: 'not available' }); return; }
      if (m.includes('NO_RECEIVER') || m.includes('NO_SENDER')) { res.status(404).json({ error: 'user not found' }); return; }
      console.error('send-gift error:', m);
      res.status(500).json({ error: 'gift failed' });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;   // for tests
