import { createClient } from '@supabase/supabase-js';

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
// NOTE: these keys were supplied in the App Room brief. This environment has no
// access to list the bucket, so they are NOT independently verified here — if a
// download 404s, reconcile the key below against the actual stored object name
// (Storage UI / API) at deploy. One-line fix per item.
const ITEM_KEYS = {
  workbook: 'Workbook_FINAL.pdf',
  guide:    'VoiceFirstPlanner-Voice-Command-Guide.pdf',
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
const STARTER = ['workbook', 'guide'];
const ANNUAL  = [...STARTER, 'research', 'values', 'goals', 'habits'];
const LIFETIME = ['workbook', 'guide', 'values', 'goals', 'habits', 'bucket',
                  'projects', 'daily', 'week', 'reflect', 'research'];

// Resolve the caller's allowed set from their entitlement.
// FLAG (Dave): assumes Annual includes the 2 starter books (Free gets them, so a
// paying Annual member shouldn't lose them). Pro is not in the v24 matrix, so it's
// treated by its source like Premium; confirm when Pro's library is defined.
function allowedItems(plan, source) {
  if (source === 'lifetime') return LIFETIME;
  const paid = plan === 'premium' || plan === 'pro';
  if (paid && source === 'annual') return ANNUAL;
  return STARTER; // free, monthly, and any unknown state -> least privilege
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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
    if (!item || !ITEM_KEYS[item]) return res.status(400).json({ error: 'Unknown item' });

    // 3. Read entitlement (service role -> bypasses RLS) and check access.
    const { data: ent } = await supabase
      .from('entitlements')
      .select('plan,source')
      .eq('user_id', userId)
      .maybeSingle();
    const plan = ent?.plan || 'free';
    const source = ent?.source || null;

    if (!allowedItems(plan, source).includes(item)) {
      return res.status(403).json({ error: 'Not included in your plan' });
    }

    // 4. Mint a short-lived signed URL from the private bucket.
    const { data: signed, error: signErr } = await supabase
      .storage.from(BUCKET)
      .createSignedUrl(ITEM_KEYS[item], SIGNED_TTL, { download: true });

    if (signErr || !signed?.signedUrl) {
      console.error('createSignedUrl failed for', item, '->', ITEM_KEYS[item], signErr?.message);
      return res.status(404).json({ error: 'File not available — please contact support' });
    }

    return res.status(200).json({ url: signed.signedUrl });
  } catch (err) {
    console.error('library-download error:', err);
    return res.status(500).json({ error: 'Download failed — please try again' });
  }
}
