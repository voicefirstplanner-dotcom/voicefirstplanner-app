// ---------------------------------------------------------------------------
// LIBRARY DOWNLOAD TOKENS  (shared, non-routable)
//
// Long-lived, per-user signed tokens that let a welcome email carry a working
// download link WITHOUT a live login session and WITHOUT any public file URL.
//
// A token proves ONE thing only: "the bearer is user <uid>, and this token has
// not expired." It carries NO entitlement, NO file list, NO tier. Which files
// the bearer may actually download is decided at DOWNLOAD TIME by reading the
// user's CURRENT entitlement in library-download.js — so a refunded Lifetime
// account whose token is still inside an old email loses the 11-file set the
// moment the refund lands, and keeps only the free Starter Books. (DoD item 6.)
//
// Signed with LIBRARY_TOKEN_SECRET — a DEDICATED secret, never the Supabase
// service-role key. These tokens sit in inboxes for years; their signing key
// must not also be the key that opens the whole database.
//
// This file lives under api/_lib/ and is deliberately NOT an HTTP route: Vercel
// does not turn paths containing an underscore-prefixed segment into functions.
// It exports helpers only; it has no default handler.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

const SECRET = process.env.LIBRARY_TOKEN_SECRET;
const DEFAULT_TTL_DAYS = 30;

// Token wire format:  <uid>.<exp>.<sig>
//   uid = Supabase user id (UUID; url-safe already)
//   exp = expiry, unix seconds (digits only)
//   sig = base64url( HMAC-SHA256( "<uid>.<exp>", SECRET ) )
// Compact, URL-safe, no JSON parsing on the hot path, nothing secret inside it.

function sign(body) {
  if (!SECRET) throw new Error('LIBRARY_TOKEN_SECRET not set');
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}

// Mint a token for a user. ttlDays defaults to 30 — long enough for a welcome
// email to stay useful, short enough that a leaked link is not forever.
export function mintToken(uid, ttlDays = DEFAULT_TTL_DAYS) {
  if (!uid) throw new Error('mintToken: uid required');
  const exp = Math.floor(Date.now() / 1000) + Math.round(ttlDays * 86400);
  const body = `${uid}.${exp}`;
  return `${body}.${sign(body)}`;
}

// Verify a token. Returns { uid } on success, or null on any failure
// (malformed, bad signature, expired). Never throws on bad input — callers
// treat null as "no valid identity" and respond with a friendly page.
// Uses a constant-time comparison so a bad signature leaks no timing signal.
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, expStr, sig] = parts;
  if (!uid || !expStr || !sig) return null;

  const expected = sign(`${uid}.${expStr}`);
  // timingSafeEqual throws if buffers differ in length — guard with a length
  // check first so a wrong-length signature is a plain false, not an exception.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return null;
  if (Math.floor(Date.now() / 1000) >= exp) return null; // expired

  return { uid };
}

// Convenience: build the full download URL a welcome email drops in for one file.
// base example: https://app.voicefirstdayplanner.com/api/library-download
export function downloadUrl(base, token, doc) {
  const u = new URL(base);
  u.searchParams.set('token', token);
  u.searchParams.set('doc', doc);
  return u.toString();
}
