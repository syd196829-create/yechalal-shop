// lib/chapa.js — a thin client for Chapa (https://developer.chapa.co): takes payments AND sends payouts.
// Needs the Vercel variable CHAPA_SECRET_KEY (use the TEST key  CHASECK_TEST-...  first, then the live one).
const crypto = require('crypto');
const BASE = 'https://api.chapa.co/v1';

function makeChapa({ secret = process.env.CHAPA_SECRET_KEY, fetchFn = (typeof fetch === 'function' ? fetch : null) } = {}) {
  async function call(method, path, body) {
    if (!secret) throw new Error('CHAPA_NOT_CONFIGURED');
    if (!fetchFn) throw new Error('NO_FETCH');
    const resp = await fetchFn(BASE + path, {
      method,
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = {};
    try { json = await resp.json(); } catch (_) {}
    if (!resp.ok) { const e = new Error('CHAPA_HTTP_' + resp.status); e.status = resp.status; e.body = json; throw e; }
    return json;
  }
  return {
    configured: !!secret,
    initialize: (p) => call('POST', '/transaction/initialize', p),            // start a payment -> data.checkout_url
    verify: (txRef) => call('GET', '/transaction/verify/' + encodeURIComponent(txRef)),
    transfer: (p) => call('POST', '/transfers', p),                           // payout to a bank / mobile-money account
    verifyTransfer: (ref) => call('GET', '/transfers/verify/' + encodeURIComponent(ref)),
    banks: () => call('GET', '/banks')
  };
}

// Chapa signs webhooks: x-chapa-signature = HMAC-SHA256(payload, secret);  chapa-signature = HMAC-SHA256(secret, secret).
function webhookSignatureOk(payloadCandidates, headers, secret) {
  if (!secret) return false;
  const hmac = (data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
  const eq = (a, b) => { a = String(a || ''); b = String(b || ''); return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); };
  const h = headers || {};
  const sigA = h['x-chapa-signature'], sigB = h['chapa-signature'];
  if (sigB && eq(sigB, hmac(secret))) return true;
  if (sigA) for (const p of payloadCandidates) if (p && eq(sigA, hmac(p))) return true;
  return false;
}

module.exports = { makeChapa, webhookSignatureOk };
