// api/project-photo-upload.js
// Project photo capture — THE upload path (Amendment 1, 28 Jul 2026).
//
// Uploads no longer go direct from the browser: `project_captures_insert_own`
// has been dropped, so the client SDK CANNOT write into the bucket at all.
// Every upload comes through here, where the tier gate lives server-side:
//
//   Premium / Pro / Lifetime  -> unlimited
//   Free                      -> three photos IN TOTAL, then 402 photo_limit
//
// The counter is the OBJECT COUNT under {user_id}/ in the bucket — nothing
// client-editable, no new column, and deleting a photo frees the slot by
// construction. Reads and deletes stay client-side under the remaining
// user-scoped RLS policies (select_own, delete_own).
//
// Shape follows library-download.js: same service-role client, same JWT
// resolution, same entitlement lookup (entitlements.plan/source — the one
// source of truth for tiers). The 5MB cap and the three MIME types are
// enforced HERE as well as in the bucket config; the client's word is never
// trusted on either.
//
//   Request  (POST, JSON): { imageB64, contentType, projectId }
//            Header:       Authorization: Bearer <supabase access token>
//   Success  (200):        { path }
//   Refusals:              401 no/bad session · 402 photo_limit (free, 3 used)
//                          · 413 too_large · 415 bad_type · 400 bad input

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
// NB: Vercel caps request bodies at ~4.5MB, so the practical binary ceiling
// through this endpoint is ~3.3MB — comfortably above the ~200–500KB the
// client's 1600px/0.8 downscale produces, and below the bucket's 5MB fence.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'project-captures';
const FREE_PHOTO_LIMIT = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Total objects under {userId}/ — one storage list for the project folders,
// then one per folder. Bounded: a free user can hold at most a handful.
async function countUserPhotos(userId) {
  const { data: top, error } = await supabase.storage.from(BUCKET)
    .list(userId, { limit: 100 });
  if (error) throw new Error('count failed: ' + error.message);
  let count = 0;
  for (const entry of top || []) {
    if (entry.id) { count++; continue; }          // stray file at the top level
    const { data: files, error: e2 } = await supabase.storage.from(BUCKET)
      .list(`${userId}/${entry.name}`, { limit: 100 });
    if (e2) throw new Error('count failed: ' + e2.message);
    count += (files || []).filter(f => f.id).length;
    if (count >= FREE_PHOTO_LIMIT) return count;  // enough to decide
  }
  return count;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    // 1 · Who is calling?
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Sign in to add photos' });
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    const userId = userData?.user?.id;
    if (userErr || !userId) return res.status(401).json({ error: 'Sign in to add photos' });

    // 2 · Input
    const { imageB64, contentType, projectId } = req.body || {};
    if (!imageB64 || typeof imageB64 !== 'string') return res.status(400).json({ error: 'No image provided' });
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) return res.status(415).json({ error: 'Photos only — JPEG, PNG or WebP', code: 'bad_type' });
    const proj = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!proj) return res.status(400).json({ error: 'Missing project' });
    let bytes;
    try { bytes = Buffer.from(imageB64, 'base64'); } catch (e) { bytes = null; }
    if (!bytes || bytes.length < 100) return res.status(400).json({ error: 'Could not read that image' });
    if (bytes.length > MAX_BYTES) return res.status(413).json({ error: 'That photo is too large — 5MB max', code: 'too_large' });

    // 3 · The tier gate — the same entitlement lookup library-download.js uses.
    const { data: ent } = await supabase
      .from('entitlements')
      .select('plan,source')
      .eq('user_id', userId)
      .maybeSingle();
    const plan = ent?.plan || 'free';
    const paid = plan === 'premium' || plan === 'pro';   // Lifetime rows carry plan=premium

    if (!paid) {
      const used = await countUserPhotos(userId);
      if (used >= FREE_PHOTO_LIMIT) {
        return res.status(402).json({
          error: `Free plan includes ${FREE_PHOTO_LIMIT} photos — upgrade to Premium for unlimited`,
          code: 'photo_limit',
        });
      }
    }

    // 4 · Upload with the service role (the only writer this bucket has left).
    const path = `${userId}/${proj}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage.from(BUCKET)
      .upload(path, bytes, { contentType, upsert: false });
    if (upErr) {
      console.error('project-photo-upload storage error user=', userId, upErr.message);
      return res.status(502).json({ error: 'Upload failed — try again' });
    }

    console.log(`project-photo-upload ok user=${userId} project=${proj} bytes=${bytes.length} plan=${plan}`);
    return res.status(200).json({ path });
  } catch (e) {
    console.error('project-photo-upload error:', e.message);
    return res.status(500).json({ error: 'Server error — try again' });
  }
}
