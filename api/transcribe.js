// api/transcribe.js
// Receives a short audio clip from the app and returns the transcribed text.
// Request  (POST, JSON):  { audio: "<base64>", mime: "audio/webm" }
//          Header:        Authorization: Bearer <supabase access token>   (signed-in users)
// Response (JSON):        { text: "the spoken words" }
//
// The OpenAI key is read from the OPENAI_API_KEY environment variable and never
// leaves the server, so it is never exposed to users' browsers.
//
// D17 (18 Jul 2026) — this endpoint used to be completely open: no auth, no rate
// limit, no attribution. Anyone with the URL could burn transcription spend. It now:
//   1. verifies the Supabase session and attributes every call to a user id
//   2. rate-limits per user (and, for the signed-out demo, per IP)
//   3. logs the actor so abuse is traceable
// It FAILS OPEN on limiter errors: a broken limiter must never take voice down,
// which is the whole product.

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

// ---- Model. Keep it on this one line so any future swap stays a one-line change. ----
const MODEL = 'gpt-4o-mini-transcribe';

// ---- Ceilings ------------------------------------------------------------------
// Signed-in: generous enough that no real person on a heavy planning day will ever
// see it, low enough that a stolen token can't run up a bill.
const USER_PER_HOUR = 60;
const USER_PER_DAY  = 250;
// Signed-out demo ("Try the demo — no account needed"): enough to genuinely try a
// voice-first app, negligible spend if abused. See ALLOW_ANON_DEMO below.
const ANON_PER_HOUR = 10;

// The demo entry point has no Supabase session by design. Setting this to false
// makes the endpoint strictly authenticated — and silently kills voice in the
// demo, which is the app's only try-before-signup path. See the delivery note.
const ALLOW_ANON_DEMO = true;

const admin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Resolve the caller. Returns { actor, kind } or null if a token was supplied but invalid.
async function identify(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return { actor: 'ip:' + clientIp(req), kind: 'anon' };
  if (!admin) return { actor: 'ip:' + clientIp(req), kind: 'anon' };
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user?.id) return null;          // token supplied but bad -> reject
    return { actor: data.user.id, kind: 'user' };
  } catch (e) {
    return null;
  }
}

// Count this actor's calls in the window and record the new one.
// Returns { allowed, used, limit, window } — fails OPEN on any error.
async function checkAndRecord(actor, kind) {
  if (!admin) return { allowed: true, degraded: true };
  const now = Date.now();
  const hourAgo = new Date(now - 3600e3).toISOString();
  const dayAgo  = new Date(now - 86400e3).toISOString();
  try {
    const { count: hourCount, error: e1 } = await admin
      .from('transcribe_usage')
      .select('id', { count: 'exact', head: true })
      .eq('actor', actor)
      .gte('created_at', hourAgo);
    if (e1) throw e1;

    const hourLimit = kind === 'user' ? USER_PER_HOUR : ANON_PER_HOUR;
    if ((hourCount || 0) >= hourLimit) {
      return { allowed: false, used: hourCount, limit: hourLimit, window: 'hour' };
    }

    if (kind === 'user') {
      const { count: dayCount, error: e2 } = await admin
        .from('transcribe_usage')
        .select('id', { count: 'exact', head: true })
        .eq('actor', actor)
        .gte('created_at', dayAgo);
      if (e2) throw e2;
      if ((dayCount || 0) >= USER_PER_DAY) {
        return { allowed: false, used: dayCount, limit: USER_PER_DAY, window: 'day' };
      }
    }

    await admin.from('transcribe_usage').insert({ actor, kind, created_at: new Date(now).toISOString() });
    return { allowed: true, used: (hourCount || 0) + 1, limit: hourLimit, window: 'hour' };
  } catch (e) {
    // Fail open. A limiter outage must not take voice down.
    console.warn('transcribe rate-limit degraded:', e.message);
    return { allowed: true, degraded: true };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ---- 1. Who is calling? --------------------------------------------------
    const who = await identify(req);
    if (!who) return res.status(401).json({ error: 'Invalid session' });
    if (who.kind === 'anon' && !ALLOW_ANON_DEMO) {
      return res.status(401).json({ error: 'Sign in to use voice' });
    }

    // ---- 2. Are they over the ceiling? ---------------------------------------
    const gate = await checkAndRecord(who.actor, who.kind);
    if (!gate.allowed) {
      console.warn(`transcribe rate-limited actor=${who.actor} kind=${who.kind} used=${gate.used}/${gate.limit} per ${gate.window}`);
      res.setHeader('Retry-After', gate.window === 'day' ? '3600' : '600');
      return res.status(429).json({
        error: who.kind === 'anon'
          ? 'Demo voice limit reached — create a free account to keep going'
          : `Voice limit reached (${gate.limit} per ${gate.window}). Try again shortly.`
      });
    }

    // ---- 3. Transcribe --------------------------------------------------------
    const { audio, mime } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'No audio provided' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY' });
    }

    const buffer = Buffer.from(audio, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Empty audio' });

    // Pick a sensible file extension from the recorded audio type.
    const type = (mime || 'audio/webm').toLowerCase();
    const ext =
      type.includes('mp4') || type.includes('m4a') || type.includes('aac') ? 'm4a' :
      type.includes('ogg') ? 'ogg' :
      type.includes('mpeg') || type.includes('mp3') ? 'mp3' :
      'webm';

    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), `audio.${ext}`);
    form.append('model', MODEL);
    form.append('language', 'en'); // remove this line if you want auto language detection

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error(`transcribe upstream fail actor=${who.actor} status=${r.status}`);
      return res.status(502).json({ error: 'Transcription failed', detail: detail.slice(0, 300) });
    }

    const data = await r.json();
    // Attribution: every call is traceable to a user id (or a demo IP).
    console.log(`transcribe ok actor=${who.actor} kind=${who.kind} bytes=${buffer.length} model=${MODEL}`);
    return res.status(200).json({ text: (data.text || '').trim() });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
