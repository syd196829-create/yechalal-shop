// /api/generate-token  — returns an Agora token ONLY to a signed-in Yechalal Shop user.
// The caller must send:  Authorization: Bearer <Firebase ID token>
// (no extra packages needed: the Firebase ID token is verified with Node's built-in crypto)
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
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

function b64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Returns the token's payload (payload.sub is the user's uid) or throws.
async function verifyFirebaseIdToken(idToken, certsOverride) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(b64url(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad header');

  const certs = certsOverride || await getGoogleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('unknown signing key');
  const key = crypto.createPublicKey(pem);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, b64url(parts[2]));
  if (!ok) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error('wrong audience');
  if (payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('wrong issuer');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('no subject');
  if (!payload.exp || payload.exp <= now) throw new Error('token expired');
  if (payload.iat && payload.iat > now + 300) throw new Error('token from the future');
  return payload;
}

module.exports = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    // 1) Who is asking? Must be a signed-in user.
    const auth = req.headers.authorization || '';
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    let uid;
    try {
      uid = (await verifyFirebaseIdToken(idToken)).sub;
    } catch (e) {
      res.status(401).json({ error: 'sign-in required' });
      return;
    }

    const channel = req.query.channel;
    if (!channel || typeof channel !== 'string' || channel.length > 128) {
      res.status(400).json({ error: 'valid channel parameter is required' });
      return;
    }

    // 2) Private 1-to-1 calls: channel is  dm-call-<uidA>_<uidB>  — only those two people may get a token.
    if (channel.startsWith('dm-call-')) {
      const pair = channel.slice('dm-call-'.length).split('_');
      if (pair.length !== 2 || !pair.includes(uid)) {
        res.status(403).json({ error: 'not a participant of this call' });
        return;
      }
    }

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !appCertificate) {
      res.status(500).json({ error: 'Agora credentials not configured on server' });
      return;
    }

    // 24h instead of 1h: a live can easily run longer than an hour, and everyone (viewers joining late,
    // or a viewer becoming a guest well into the stream) reuses this token for the whole session.
    const privilegeExpiredTs = Math.floor(Date.now() / 1000) + 24 * 3600;
    const role = RtcRole.PUBLISHER;   // TODO next step: audience-only for viewers, publisher only for host / approved guests

    const token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channel, 0, role, privilegeExpiredTs);
    res.status(200).json({ token });
  } catch (err) {
    res.status(500).json({ error: 'token error' });
  }
};

module.exports.verifyFirebaseIdToken = verifyFirebaseIdToken;   // exported only so it can be tested
