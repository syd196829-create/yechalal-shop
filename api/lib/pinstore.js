// lib/pinstore.js — the Security PIN, checked ON THE SERVER (never on the phone).
//
//  • The PIN is stored only in the private collection "userSecrets" (the Firestore rules deny every
//    phone; only this server code, which uses the Admin SDK, can read or write it).
//  • Stored as a salted scrypt hash, never as the number itself.
//  • 5 wrong tries in a row lock the PIN for 15 minutes — the counter lives on the server, so
//    clearing the phone's data or using another phone does not reset it.
//  • Old accounts that still have the weak public hash (users/<uid>.securityPinHash) are moved into
//    the private document automatically and upgraded to the strong hash on the first correct PIN.
const crypto = require('crypto');

const PIN_RE = /^\d{4}$/;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const scryptHex = (pin, saltHex) => crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32, SCRYPT).toString('hex');
const legacyHash = (uid, pin) => crypto.createHash('sha256').update(uid + ':' + pin).digest('hex');   // what the old app stored
function safeEq(a, b) {
  const A = Buffer.from(String(a || ''), 'hex'), B = Buffer.from(String(b || ''), 'hex');
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}
function newRecord(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { pinSalt: salt, pinHash: scryptHex(pin, salt), alg: 'scrypt-v1' };
}
const secretRef = (db, uid) => db.collection('userSecrets').doc(uid);
const userRef = (db, uid) => db.collection('users').doc(uid);

// Does this person have a PIN? Also moves an old public hash into the private document.
async function pinStatus(db, FieldValue, uid) {
  const [s, u] = await Promise.all([secretRef(db, uid).get(), userRef(db, uid).get()]);
  const sd = s.exists ? (s.data() || {}) : {};
  const ud = u.exists ? (u.data() || {}) : {};
  let hasPin = !!(sd.pinHash || sd.legacyHash);
  if ('securityPinHash' in ud) {
    if (!hasPin && ud.securityPinHash) {
      await secretRef(db, uid).set({ legacyHash: ud.securityPinHash, fails: 0, lockedUntil: 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      hasPin = true;
    }
    await userRef(db, uid).update({ securityPinHash: FieldValue.delete() }).catch(() => {});
  }
  const now = Date.now();
  const lockedUntil = Number(sd.lockedUntil || 0);
  return { hasPin, locked: lockedUntil > now, retryAfterSec: lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0 };
}

// Checks a PIN and counts wrong tries. It runs in its OWN transaction on purpose: a wrong guess
// must stay counted even if the caller (e.g. withdraw) fails afterwards.
// Returns { state: 'ok' | 'none' | 'bad' | 'wrong' | 'locked', attemptsLeft?, retryAfterSec? }
async function checkPin(db, FieldValue, uid, pin) {
  if (!PIN_RE.test(String(pin == null ? '' : pin))) return { state: 'bad' };
  const sRef = secretRef(db, uid), uRef = userRef(db, uid);
  return db.runTransaction(async (tx) => {
    const [s, u] = await Promise.all([tx.get(sRef), tx.get(uRef)]);
    const sd = s.exists ? (s.data() || {}) : {};
    const ud = u.exists ? (u.data() || {}) : {};
    const strong = !!sd.pinHash;
    const legacy = sd.legacyHash || ud.securityPinHash || null;
    if (!strong && !legacy) return { state: 'none' };
    const now = Date.now();
    const lockedUntil = Number(sd.lockedUntil || 0);
    if (lockedUntil > now) return { state: 'locked', retryAfterSec: Math.ceil((lockedUntil - now) / 1000) };
    const good = strong ? safeEq(scryptHex(pin, sd.pinSalt), sd.pinHash) : safeEq(legacyHash(uid, pin), legacy);
    if (good) {
      const patch = { fails: 0, lockedUntil: 0, updatedAt: FieldValue.serverTimestamp() };
      if (!strong) Object.assign(patch, newRecord(pin), { legacyHash: FieldValue.delete() });   // upgrade weak -> strong
      tx.set(sRef, patch, { merge: true });
      if ('securityPinHash' in ud) tx.update(uRef, { securityPinHash: FieldValue.delete() });
      return { state: 'ok' };
    }
    const fails = Number(sd.fails || 0) + 1;
    const lock = fails >= MAX_FAILS;
    tx.set(sRef, { fails: lock ? 0 : fails, lockedUntil: lock ? now + LOCK_SECONDS * 1000 : 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return lock ? { state: 'locked', retryAfterSec: LOCK_SECONDS } : { state: 'wrong', attemptsLeft: MAX_FAILS - fails };
  });
}

async function setPin(db, FieldValue, uid, newPin) {
  await secretRef(db, uid).set({ ...newRecord(newPin), legacyHash: FieldValue.delete(), fails: 0, lockedUntil: 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await userRef(db, uid).update({ securityPinHash: FieldValue.delete() }).catch(() => {});
}
async function removePin(db, FieldValue, uid) {
  await secretRef(db, uid).delete();
  await userRef(db, uid).update({ securityPinHash: FieldValue.delete() }).catch(() => {});
}

module.exports = { PIN_RE, MAX_FAILS, LOCK_SECONDS, legacyHash, pinStatus, checkPin, setPin, removePin };
