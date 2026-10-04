// Verifies a Firebase ID token (the "login proof" the app sends) using only Node's built-in crypto.
// Returns the token payload (payload.sub = the user's uid) or throws.
const crypto = require('crypto');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'yechalal-shop';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certCache = { certs: null, exp: 0 };
async function getGoogleCerts() {
  if (certCache.certs && Date.now() < certCache.exp) return certCache.certs;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error('could not load Google certificates');
  const certs = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  certCache = { certs, exp: Date.now() + (m ? parseInt(m[1], 10) : 3600) * 1000 };
  return certs;
}

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verifyFirebaseIdToken(idToken, certsOverride) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(b64url(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad header');
  const certs = certsOverride || (await getGoogleCerts());
  const pem = certs[header.kid];
  if (!pem) throw new Error('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey(pem), b64url(parts[2]));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error('wrong audience');
  if (payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('wrong issuer');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('no subject');
  if (!payload.exp || payload.exp <= now) throw new Error('token expired');
  return payload;
}

module.exports = { verifyFirebaseIdToken };
