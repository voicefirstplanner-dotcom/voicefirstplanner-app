// ---------------------------------------------------------------------------
// api/workbook-download.js: THE FREE WORKBOOK (2 Sep 2026)
//
// Takes a token from the delivery email, verifies it, and answers with a
// 60-second signed URL for one file. No login, no entitlement lookup, no
// account required: that is the whole point of rung one.
//
// ⛔ THIS IS NOT library-download.js AND MUST NEVER BECOME IT. That endpoint
// reads a user's CURRENT entitlement to decide which of twelve files they may
// have. This one serves exactly one free file and never consults entitlements,
// the captures row's contents, or founding_number. If a future brief asks this
// file to serve a second document, that is a different endpoint.
//
// A bad, tampered or expired token gets the same short page in every case. It
// never says which of those it was, and it never returns a file.
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';
import { verifyToken } from './_lib/token.js';

const admin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const BUCKET = 'lifetime-library';
const OBJECT_KEY = 'workbook.pdf';
const SIGNED_URL_SECONDS = 60;
const SITE = 'voicefirstdayplanner.com';

// One page for every failure. Plain, no blame, and it tells the reader exactly
// what to do next rather than leaving them at a dead end.
function expiredPage(res, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>That link has expired</title>
</head>
<body style="margin:0;background:#F0F5FB;font-family:Georgia,'Times New Roman',serif;color:#1a2a3a;">
  <div style="max-width:520px;margin:12vh auto;padding:28px 26px;background:#fff;border-radius:10px;">
    <h1 style="font-size:20px;color:#0C447C;margin:0 0 12px;">That link has expired</h1>
    <p style="font-size:16px;line-height:1.5;margin:0 0 18px;">Download links stay live for 30 days. Ask for the workbook again and a fresh link comes straight back.</p>
    <p style="font-size:16px;line-height:1.5;margin:0;"><a href="https://${SITE}/start" style="color:#0C447C;font-weight:700;">${SITE}/start</a></p>
  </div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(html);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // No token, bad signature, wrong shape, expired: all the same answer.
  const raw = req.query?.t;
  const token = Array.isArray(raw) ? raw[0] : raw;
  const claim = token ? verifyToken(token) : null;
  if (!claim) return expiredPage(res);

  // The subject must be one of ours. A validly signed token for something else
  //: a library token for a real user id, say , does not open this file.
  if (!String(claim.uid || '').startsWith('wb:')) {
    console.warn('workbook-download: valid token, wrong subject scope');
    return expiredPage(res);
  }

  if (!admin) {
    console.error('workbook-download: no admin client');
    return expiredPage(res);
  }

  try {
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(OBJECT_KEY, SIGNED_URL_SECONDS);

    if (error || !data?.signedUrl) {
      console.error('workbook-download: signing failed:', error?.message);
      return expiredPage(res);
    }

    // Best effort, never blocking: note that this subject downloaded. The
    // subject hash is stored on the row at capture time, which is the only way
    // back to it: the address itself is not recoverable from the token.
    try {
      await admin.from('captures')
        .update({ last_download_at: new Date().toISOString() })
        .eq('subject_hash', claim.uid);
    } catch (e) {
      console.warn('workbook-download: last_download_at not updated:', e.message);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, data.signedUrl);
  } catch (e) {
    console.error('workbook-download failed:', e.message);
    return expiredPage(res);
  }
}
