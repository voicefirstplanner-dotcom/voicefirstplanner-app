// api/project-photo-upload.js
// Project photo capture — THE upload path (Amendment 1, 28 Jul 2026) — and, from
// 10 Oct 2026, project FILES as well (Projects rebuild part 1, brief item 3).
//
// Uploads never go direct from the browser on the user's own key:
// `project_captures_insert_own` was dropped, so the client SDK CANNOT write into
// the bucket. Every new object is either written here (photos) or written with
// a one-use upload pass issued here (files). The tier gate lives here:
//
//   Premium / Pro / Lifetime  -> unlimited
//   Free                      -> three photos AND files IN TOTAL, then 402 photo_limit
//                                (one shared count until Dave rules — brief "Free and paid")
//
// The count is taken in the database by public.pc_reserve(), under a per-user
// lock: the objects under {user_id}/ in the bucket, plus upload passes handed
// out and not yet used. Several requests sent at once therefore cannot all see
// "2 used" (the gap the 28 July count had). At the limit, a pass not yet used is
// handed out again for the SAME path, so no extra object can ever be made from it.
// Deleting a photo or file frees the slot by construction.
//
//   Photo (POST, JSON): { imageB64, contentType, projectId }
//         -> 200 { path }           the server uploads it (5MB, JPEG/PNG/WebP)
//   File  (POST, JSON): { mode: 'file', projectId, contentType, size }
//         -> 200 { path, token }    the browser uploads to that path with the pass
//                                   (supabase.storage.uploadToSignedUrl); the bucket
//                                   itself refuses anything over 10MB or of another type
//   Header: Authorization: Bearer <supabase access token>
//   Refusals: 401 no/bad session · 402 photo_limit · 413 too_large · 415 bad_type · 400 bad input

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
// NB: Vercel caps request bodies at ~4.5MB, so the practical binary ceiling for a
// PHOTO through this endpoint is ~3.3MB (the client downscales to ~200–500KB).
// Files do not pass through here at all: only their pass does.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'project-captures';
const FREE_PHOTO_LIMIT = 3;                 // photos and files together, free plan
const MAX_BYTES = 5 * 1024 * 1024;          // photos
const FILE_MAX_BYTES = 10 * 1024 * 1024;    // files (the bucket's own limit is the same)
const ALLOWED_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const FILE_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

// Free plan: ask the database for a slot. Returns the path to use (the one asked
// for, or an unused pass's path when at the limit), or null when refused.
async function reserveSlot(userId, path) {
  const { data, error } = await supabase.rpc('pc_reserve', { p_user: userId, p_path: path, p_limit: FREE_PHOTO_LIMIT });
  if (error) throw new Error('reserve failed: ' + error.message);
  return data || null;
}

function limitRefusal(res) {
  return res.status(402).json({
    error: `Free plan includes ${FREE_PHOTO_LIMIT} photos and files — upgrade to Premium for unlimited`,
    code: 'photo_limit',
  });
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

    const body = req.body || {};
    const proj = String(body.projectId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!proj) return res.status(400).json({ error: 'Missing project' });
    const rand = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 2 · The tier — the same entitlement lookup library-download.js uses.
    const { data: ent } = await supabase
      .from('entitlements')
      .select('plan,source')
      .eq('user_id', userId)
      .maybeSingle();
    const plan = ent?.plan || 'free';
    const paid = plan === 'premium' || plan === 'pro';   // Lifetime rows carry plan=premium

    // 3a · A FILE: check, count, then hand out a one-use upload pass.
    if (body.mode === 'file') {
      const ext = FILE_TYPES[body.contentType];
      if (!ext) return res.status(415).json({ error: 'PDF, pictures, Word or Excel only', code: 'bad_type' });
      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'Could not read that file' });
      if (size > FILE_MAX_BYTES) return res.status(413).json({ error: 'That file is too large — 10MB max', code: 'too_large' });
      // No extension on a file's path: an unused pass may be handed out again for a
      // different file, and the browser keeps the real name and type.
      let path = `${userId}/${proj}/${rand()}-file`;
      if (!paid) {
        path = await reserveSlot(userId, path);
        if (!path) return limitRefusal(res);
      }
      const { data: pass, error: passErr } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (passErr || !pass?.token) {
        console.error('project-file pass error user=', userId, passErr && passErr.message);
        return res.status(502).json({ error: 'Upload failed — try again' });
      }
      console.log(`project-file pass ok user=${userId} project=${proj} size=${size} type=${ext} plan=${plan}`);
      return res.status(200).json({ path, token: pass.token });
    }

    // 3b · A PHOTO: as on 28 July, with the count now taken under the lock.
    const { imageB64, contentType } = body;
    if (!imageB64 || typeof imageB64 !== 'string') return res.status(400).json({ error: 'No image provided' });
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) return res.status(415).json({ error: 'Photos only — JPEG, PNG or WebP', code: 'bad_type' });
    let bytes;
    try { bytes = Buffer.from(imageB64, 'base64'); } catch (e) { bytes = null; }
    if (!bytes || bytes.length < 100) return res.status(400).json({ error: 'Could not read that image' });
    if (bytes.length > MAX_BYTES) return res.status(413).json({ error: 'That photo is too large — 5MB max', code: 'too_large' });

    let path = `${userId}/${proj}/${rand()}.${ext}`;
    if (!paid) {
      path = await reserveSlot(userId, path);
      if (!path) return limitRefusal(res);
    }

    // 4 · Upload with the service role (the only writer this bucket has).
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
