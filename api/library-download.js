import { createClient } from '@supabase/supabase-js';
import { verifyToken } from './_lib/token.js';

// Service-role client: validates the caller's JWT, reads their entitlement, and
// mints signed URLs from the PRIVATE lifetime-library bucket. The service key
// never leaves the server.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'lifetime-library';
const SIGNED_TTL = 60; // seconds — long enough to start the download, short enough not to be shareable

// item id -> exact object key in the bucket.
// VERIFIED 24 Jul 2026 against the actual objects in the `lifetime-library`
// bucket — all eleven keys match byte-for-byte. Do NOT rename any object in
// Storage without updating the matching key here AND re-issuing links: a rename
// breaks the in-app Library and every tokenised link already sitting in an inbox.
const ITEM_KEYS = {
  // Job 3 (11 Aug): all three starter books were rebuilt in Design and uploaded
  // under new object names. The IDS are unchanged, so the welcome email's
  // sentinels stay stable (Job 4 owns that file). `book2` is deliberately absent
  // — it is a flag row with no file until it publishes, so a request for it must
  // fall through to unknown_item.
  // Keys are plain ASCII, lowercase, hyphens only (Management's 11 Aug ruling):
  // spaces need URL-encoding on every request and an em dash can normalise
  // differently between upload and request. Display titles live in
  // LIBRARY_ITEMS and are unaffected by these names.
  manual:   'instruction-manual.pdf',
  guide:    'voice-command-guide.pdf',
  workbook: 'starter-workbook.pdf',
  values:   '1) VFP_PDF_Values_Busy_Isnt_The_Same_As_Living_Well_FINAL_v2.pdf',
  goals:    '2) VFP_PDF_Goals_Wishing_Isnt_The_Same_As_Deciding_v1.pdf',
  habits:   '3) VFP_PDF_Habits_Motivation_Isnt_The_Same_As_Momentum_v1.pdf',
  bucket:   '4) VFP_PDF_BucketList_Someday_Isnt_The_Same_As_A_Plan_v1.pdf',
  projects: '5) VFP_PDF_Projects_Effort_Isnt_The_Same_As_Progress_v1.pdf',
  daily:    '6) VFP_PDF_DailyPlanning_A_Full_Day_Isnt_The_Same_As_A_Good_Day_v1.pdf',
  week:     '7) VFP_PDF_WeekAhead_A_Week_Isnt_The_Same_As_Seven_Days_v1.pdf',
  reflect:  '8) VFP_PDF_Reflect_Experience_Isnt_The_Same_As_Wisdom_v1.pdf',
  research: 'VFP_WhyThisWorks_Evidence.pdf',
};

// Tier -> allowed item ids. Starter books are available to every signed-in tier;
// higher tiers layer on top. This is the AUTHORITATIVE boundary — the Settings UI
// mirrors it for display, but access is decided here.
// Per Pricing v8 section 1 — quoted, never computed. index.html mirrors these
// for display; THIS is the boundary that decides access.
const STARTER    = ['manual', 'guide', 'workbook'];                            // 3 — free
const MONTHLY    = [...STARTER, 'values'];                                     // 4 — Premium AND Pro monthly
const ANNUAL     = [...STARTER, 'values', 'goals', 'habits', 'research'];      // 7 — Premium Annual
const PRO_ANNUAL = [...ANNUAL, 'reflect'];                                     // 8 — Pro Annual
// ⛔ LIFETIME IS EXPLICIT, NOT INHERITED — listing every id by hand is what makes
// a new book's absence visible here. The Manual is present deliberately.
const LIFETIME   = ['manual', 'guide', 'workbook', 'values', 'goals', 'habits',
                    'bucket', 'projects', 'daily', 'week', 'reflect', 'research']; // 12

// Resolve the caller's allowed set from their entitlement. The earlier flag —
// "Pro is not in the matrix, confirm when Pro's library is defined" — is now
// answered by v8 section 1: Pro Annual is Premium Annual plus Reflect, and both
// Monthly tiers carry Values.
function allowedItems(plan, source) {
  if (source === 'lifetime') return LIFETIME;
  const paid = plan === 'premium' || plan === 'pro';
  if (paid && source === 'annual') return plan === 'pro' ? PRO_ANNUAL : ANNUAL;
  if (paid) return MONTHLY;
  return STARTER; // free and any unknown state -> least privilege
}

// Read a user's CURRENT entitlement and decide whether they may have `item`,
// then mint a fresh 60s signed URL. Shared by BOTH auth paths (JWT session and
// long-lived token) so the access rule lives in exactly one place. Entitlement
// is read HERE, at request time — never baked into a token — so access always
// reflects the present, not the moment a link was issued.
// Returns { ok:true, url } or { ok:false, status, code }.
async function resolveDownload(userId, item) {
  if (!item || !ITEM_KEYS[item]) return { ok: false, status: 400, code: 'unknown_item' };

  const { data: ent } = await supabase
    .from('entitlements')
    .select('plan,source')
    .eq('user_id', userId)
    .maybeSingle();
  const plan = ent?.plan || 'free';
  const source = ent?.source || null;

  if (!allowedItems(plan, source).includes(item)) {
    return { ok: false, status: 403, code: 'not_in_plan' };
  }

  const { data: signed, error: signErr } = await supabase
    .storage.from(BUCKET)
    .createSignedUrl(ITEM_KEYS[item], SIGNED_TTL, { download: true });

  if (signErr || !signed?.signedUrl) {
    console.error('createSignedUrl failed for', item, '->', ITEM_KEYS[item], signErr?.message);
    return { ok: false, status: 404, code: 'file_missing' };
  }
  return { ok: true, url: signed.signedUrl };
}

// Minimal branded page for the browser (token/GET path). Kept tiny and inline —
// this is only ever seen when an emailed link can't be served.
function page(res, status, heading, body) {
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VoiceFirstPlanner</title></head>
<body style="margin:0;background:#F0F5FB;font-family:Helvetica,Arial,sans-serif;color:#2C2C2A;">
<div style="max-width:520px;margin:48px auto;background:#fff;border-radius:10px;overflow:hidden;">
<div style="background:#0C447C;height:6px;"></div>
<div style="padding:32px;">
<h1 style="font-size:20px;color:#0C447C;margin:0 0 12px;">${heading}</h1>
<p style="font-size:16px;line-height:1.5;margin:0 0 20px;">${body}</p>
<a href="https://app.voicefirstdayplanner.com/#library"
   style="display:inline-block;padding:12px 24px;background:#0C447C;color:#fff;font-weight:700;text-decoration:none;border-radius:8px;">
   Open your Library &rarr;</a>
</div></div></body></html>`);
}

export default async function handler(req, res) {
  // -------------------------------------------------------------------------
  // GET — tokenised link from a welcome email. No login session; the signed
  // token is the identity. On success we 302 straight to the signed bucket URL
  // so the file downloads directly from the email. Errors render a friendly
  // page (this is opened in a browser), never JSON.
  // -------------------------------------------------------------------------
  if (req.method === 'GET') {
    const token = req.query.token;
    const item = req.query.doc || req.query.item;

    const claim = verifyToken(Array.isArray(token) ? token[0] : token);
    if (!claim) {
      return page(res, 410, 'This link has expired',
        'Download links in your welcome email are valid for 30 days. Yours has expired — but every file is still waiting for you. Sign in and open your Library to grab it.');
    }

    const norm = Array.isArray(item) ? item[0] : item;
    const result = await resolveDownload(claim.uid, norm);
    if (result.ok) {
      res.writeHead(302, { Location: result.url });
      return res.end();
    }
    if (result.code === 'not_in_plan') {
      return page(res, 403, 'Not part of your plan',
        'This file isn\u2019t included in your current plan. Open your Library to see everything you do have — and how to unlock the rest.');
    }
    if (result.code === 'unknown_item') {
      return page(res, 400, 'Something\u2019s off with this link',
        'We couldn\u2019t tell which file this link is for. Open your Library and download it directly.');
    }
    return page(res, 404, 'File temporarily unavailable',
      'We couldn\u2019t fetch this file just now. Please open your Library to download it, or reply to your welcome email and I\u2019ll sort it.');
  }

  // -------------------------------------------------------------------------
  // POST — in-app Library. The JWT is the identity; unchanged behaviour.
  // -------------------------------------------------------------------------
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Authenticate — the JWT is the identity, never a client-sent userId.
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign in to download' });

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Sign in to download' });
    const userId = userData.user.id;

    // 2. Validate the requested item.
    const { item } = req.body || {};
    if (!item || !ITEM_KEYS[item]) return res.status(400).json({ error: 'Unknown item', code: 'unknown_item' });

    // 3. Read entitlement + check access + mint URL (shared with the GET path).
    const result = await resolveDownload(userId, item);
    if (!result.ok) {
      // Machine-readable codes, same pattern as the Pro endpoints' not_pro.
      if (result.code === 'not_in_plan') return res.status(403).json({ error: 'Not included in your plan', code: 'not_in_plan' });
      if (result.code === 'file_missing') return res.status(404).json({ error: 'File not available — please contact support', code: 'file_missing' });
      return res.status(400).json({ error: 'Unknown item', code: 'unknown_item' });
    }

    return res.status(200).json({ url: result.url });
  } catch (err) {
    console.error('library-download error:', err);
    return res.status(500).json({ error: 'Download failed — please try again' });
  }
}
