import {sha256} from './sha256.mjs';
/** BIP-340 Schnorr signature verification over secp256k1 (verify only — this page never holds a private key).
 * Reference: BIP-340 "Verification" (sha256 tagged hash "BIP0340/challenge", even-Y lift_x).
 * Used to check a wallet-returned signature against the exact Kaspa sighash before anything is submitted.
 * Plain BigInt; ~10–30 ms per verification in a browser, fine for <= 8 inputs.
 */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n, 1n];

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function pow(b, e, m = P) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
const inv = a => pow(a, P - 2n);
// Jacobian coordinates [X, Y, Z]; infinity has Z = 0.
function dbl([x, y, z]) {
  if (z === 0n || y === 0n) return [0n, 1n, 0n];
  const yy = y * y % P, s = 4n * x * yy % P, m = 3n * x * x % P;
  const x3 = mod(m * m - 2n * s), y3 = mod(m * (s - x3) - 8n * yy * yy), z3 = 2n * y * z % P;
  return [x3, y3, z3];
}
function add(a, b) {
  if (a[2] === 0n) return b; if (b[2] === 0n) return a;
  const z1z1 = a[2] * a[2] % P, z2z2 = b[2] * b[2] % P;
  const u1 = a[0] * z2z2 % P, u2 = b[0] * z1z1 % P, s1 = a[1] * b[2] % P * z2z2 % P, s2 = b[1] * a[2] % P * z1z1 % P;
  if (u1 === u2) return s1 === s2 ? dbl(a) : [0n, 1n, 0n];
  const h = mod(u2 - u1), r = mod(s2 - s1), hh = h * h % P, hhh = h * hh % P, v = u1 * hh % P;
  const x3 = mod(r * r - hhh - 2n * v), y3 = mod(r * (v - x3) - s1 * hhh), z3 = a[2] * b[2] % P * h % P;
  return [x3, y3, z3];
}
function mul(pt, k) { let r = [0n, 1n, 0n], q = pt; while (k > 0n) { if (k & 1n) r = add(r, q); q = dbl(q); k >>= 1n; } return r; }
function affine([x, y, z]) { if (z === 0n) return null; const zi = inv(z), zi2 = zi * zi % P; return [x * zi2 % P, y * zi2 % P * zi % P]; }
function liftX(x) {
  if (x >= P) return null;
  const c = mod(x * x % P * x + 7n), y = pow(c, (P + 1n) / 4n);
  if (y * y % P !== c) return null;
  return [x, (y & 1n) === 0n ? y : P - y, 1n];
}
const big = b => BigInt('0x' + (Array.from(b, x => x.toString(16).padStart(2, '0')).join('') || '0'));
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
// Pure-JS SHA-256 (no crypto.subtle): works on plain-http LAN pages, which are not secure contexts.
const CHALLENGE_TAG = sha256(new TextEncoder().encode('BIP0340/challenge'));
const taggedChallenge = msg => sha256(concat(CHALLENGE_TAG, CHALLENGE_TAG, msg));

/** @param pub 32-byte x-only key, msg 32-byte message, sig 64-byte (r||s). Returns boolean (never throws for bad input lengths). */
export async function schnorrVerify(pub, msg, sig) {
  if (!(pub instanceof Uint8Array) || !(msg instanceof Uint8Array) || !(sig instanceof Uint8Array)) return false;
  if (pub.length !== 32 || msg.length !== 32 || sig.length !== 64) return false;
  const Pt = liftX(big(pub)); if (!Pt) return false;
  const r = big(sig.subarray(0, 32)), s = big(sig.subarray(32)); if (r >= P || s >= N) return false;
  const e = mod(big(taggedChallenge(concat(sig.subarray(0, 32), pub, msg))), N);
  const R = affine(add(mul(G, s), mul(Pt, N - e)));
  return R !== null && (R[1] & 1n) === 0n && R[0] === r;
}
