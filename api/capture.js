// ---------------------------------------------------------------------------
// api/capture.js: EMAIL CAPTURE, RUNG ONE OF THE LADDER (2 Sep 2026)
//
// An address gets the workbook. A free account gets the three books. Paid gets
// the rest. THIS FILE IS RUNG ONE ONLY: no account is created, no entitlement
// is written, no card is involved, and nothing here reads or touches
// library-download.js, the entitlements table, or founding_number. It is a
// separate, free path and it stays that way.
//
// The form lives on the marketing site; this endpoint lives on the app, so the
// only origin allowed through CORS is the marketing domain.
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { mintToken, verifyToken } from './_lib/token.js';

const admin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Dave <dave@voicefirstdayplanner.com>';
const ALLOWED_ORIGIN = process.env.CAPTURE_ALLOWED_ORIGIN || 'https://voicefirstdayplanner.com';
const audienceId = () => process.env.RESEND_AUDIENCE_ID || '';   // read at call time
const APP_BASE = 'https://app.voicefirstdayplanner.com';
const SITE = 'voicefirstdayplanner.com';

// Page slugs a form may declare. Anything not on this list is recorded as
// 'start' rather than rejected: a mistyped slug must not cost us the address.
// Persona slugs are appended here as those pages ship.
const ALLOWED_SOURCES = ['start'];

// Per IP, 5 per hour, on the shared transcribe_usage table as kind='capture'.
// transcribe.js already excludes non-voice kinds from its own ceilings, so this
// cannot eat into anyone's voice allowance.
const PER_HOUR = 5;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Salted with LIBRARY_TOKEN_SECRET so the raw IP never reaches the database and
// a bare hash cannot be reversed: the whole IPv4 space is small enough to
// rainbow-table in seconds without a salt.
function hashWithSecret(value) {
  const secret = process.env.LIBRARY_TOKEN_SECRET || '';
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

// The token subject. The address itself never travels in the URL; the subject
// is a one-way hash of it, and `subject_hash` on the captures row is what lets
// workbook-download.js find the right row again.
function subjectFor(email) {
  return 'wb:' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
}

// Deliberately permissive: one @, something either side, a dot in the domain,
// no spaces. Anything stricter rejects real addresses, and the only cost of a
// plausible-but-wrong address is one bounced email.
function validEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s || s.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

async function rateLimited(actor) {
  if (!admin) return false;                       // fail OPEN, as transcribe does
  try {
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const { count, error } = await admin
      .from('transcribe_usage')
      .select('id', { count: 'exact', head: true })
      .eq('actor', actor)
      .eq('kind', 'capture')
      .gte('created_at', hourAgo);
    if (error) throw error;
    if ((count || 0) >= PER_HOUR) return true;
    await admin.from('transcribe_usage').insert({ actor, kind: 'capture', created_at: new Date().toISOString() });
    return false;
  } catch (e) {
    console.warn('capture rate-limit degraded:', e.message);
    return false;
  }
}

// Resend contacts. The account is expected on the global Contacts model
// (contacts are global, segments are optional, custom properties supported).
// If this account has not migrated, POST /contacts answers 404 and we fall back
// to the audience path: which needs RESEND_AUDIENCE_ID. Which one actually
// fired is logged, so the delivery can report it rather than assume it.
async function upsertContact(email, source, capturedAt) {
  const headers = { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  const properties = { source, captured_at: capturedAt };
  const read = async r => { try { return (await r.text()).slice(0, 300); } catch (e) { return ''; } };

  // First live capture (2 Sep): POST /contacts answered a validation error, the
  // code misread it as "already exists" and PATCHed a contact that was never
  // created, which 404'd. Two corrections. (1) Only 409 means exists; anything
  // else is a refusal and its body is logged verbatim so the record says why.
  // (2) Custom properties must be defined in Resend > Audience > Properties
  // before the API will accept them. If they are refused, the contact is
  // stored again WITHOUT them, so rung one is always counted in Resend and the
  // properties are best effort until Dave defines them.
  let r = await fetch('https://api.resend.com/contacts', {
    method: 'POST', headers, body: JSON.stringify({ email, unsubscribed: false, properties }),
  });
  if (r.ok) return { ok: true, model: 'contacts', action: 'created', properties: true };

  if (r.status === 409) {
    const u = await fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}`, {
      method: 'PATCH', headers, body: JSON.stringify({ unsubscribed: false, properties }),
    });
    if (u.ok) return { ok: true, model: 'contacts', action: 'updated', properties: true };
    return { ok: false, model: 'contacts', step: 'patch', status: u.status, body: await read(u) };
  }

  // Not migrated: the global endpoint does not exist on this account.
  if (r.status === 404 && audienceId()) {
    const a = await fetch(`https://api.resend.com/audiences/${audienceId()}/contacts`, {
      method: 'POST', headers, body: JSON.stringify({ email, unsubscribed: false }),
    });
    if (a.ok || a.status === 409) return { ok: true, model: 'audiences', action: a.ok ? 'created' : 'existed', properties: false };
    return { ok: false, model: 'audiences', step: 'post', status: a.status, body: await read(a) };
  }

  // Refused with properties: keep the reason, then store the contact without them.
  const firstBody = await read(r);
  const bare = await fetch('https://api.resend.com/contacts', {
    method: 'POST', headers, body: JSON.stringify({ email, unsubscribed: false }),
  });
  if (bare.ok || bare.status === 409) {
    return { ok: true, model: 'contacts', action: bare.ok ? 'created' : 'existed', properties: false,
             propertiesRefused: { status: r.status, body: firstBody } };
  }
  return { ok: false, model: 'contacts', step: 'post', status: r.status, body: firstBody,
           bareStatus: bare.status, bareBody: await read(bare) };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Copy is Management's, word for word, and it was written against a list of
// banned words and phrases held in the brief. Nothing in here is the room's to
// reword: a line that will not work gets flagged, never replaced.
function deliveryHtml(downloadLink) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">Twenty-four things that go wrong with a day, and what to do about each one.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:10px;padding:28px 26px;font-family:Georgia,'Times New Roman',serif;color:#1a2a3a;">
      <tr><td>
        <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Here is the workbook.</p>

        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr><td style="border:1.5px solid #0C447C;border-radius:26px;">
          <a href="${esc(downloadLink)}" style="display:inline-block;padding:12px 26px;color:#0C447C;font-size:15px;font-weight:700;text-decoration:none;">Download The VoiceFirstPlanner Workbook</a>
        </td></tr></table>

        <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">You do not have to use all of it. Find the one page that is today's problem and do that page. The rest is there when you want it.</p>

        <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Everything in it works out loud in VoiceFirstPlanner, which is free forever with no card, and you can look around the whole thing before you make an account.</p>

        <p style="font-size:16px;line-height:1.5;margin:0 0 22px;"><a href="https://${SITE}" style="color:#0C447C;font-weight:700;text-decoration:none;">Take a look around first: ${SITE}</a></p>

        <p style="font-size:16px;line-height:1.5;margin:0 0 2px;">Dave Rees</p>
        <p style="font-size:16px;line-height:1.5;margin:0 0 24px;">Founder, VoiceFirstPlanner</p>

        <p style="font-size:13px;line-height:1.5;color:#4a5a6a;margin:0 0 14px;">You asked for the workbook at ${SITE}. If you would rather not hear from us again, reply to this email with the word unsubscribe.</p>

        <p style="font-size:12px;line-height:1.5;color:#6b7a89;margin:0;border-top:1px solid #DCE6F0;padding-top:12px;">VoiceFirstPlanner Limited &middot; <a href="https://${SITE}" style="color:#6b7a89;">${SITE}</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// THE DOWNLOAD, FOLDED IN (2 Sep 2026)
//
// This was api/workbook-download.js, its own file, exactly as briefed. Vercel's
// Hobby plan allows 12 serverless functions per deployment and api/ already
// held 11, so two new files made 13 and every deploy failed. Rather than drop a
// requirement or ask for a paid plan mid-walk, the two endpoints share one
// function and the briefed URL is preserved by a rewrite in vercel.json:
// /api/workbook-download still resolves, so the link inside every email sent is
// unchanged and will keep working forever.
//
// The two paths stay strictly separate in behaviour: POST captures, GET serves
// the one free file. Nothing about the entitlement separation changes.
// ---------------------------------------------------------------------------

const BUCKET = 'lifetime-library';
const OBJECT_KEY = 'workbook.pdf';
const SIGNED_URL_SECONDS = 60;

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

async function handleDownload(req, res) {
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

export default async function handler(req, res) {
  // CORS: the marketing site only. Nothing else may call this from a browser.
  const origin = req.headers.origin || '';
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    // A preflight from anywhere else gets no allow header, so the browser stops it.
    return res.status(origin === ALLOWED_ORIGIN ? 204 : 403).end();
  }
  // GET is the workbook download (see the note above). POST is the capture.
  if (req.method === 'GET') return handleDownload(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'origin_not_allowed' });
  }

  try {
    const body = req.body || {};

    // Honeypot: a hidden field a person never sees and a bot fills in. Answer
    // 200 and do nothing at all, so the bot learns nothing from the response.
    const hp = body.website ?? body.company ?? body.hp ?? '';
    if (String(hp).trim() !== '') {
      console.log('capture honeypot tripped, ignored');
      return res.status(200).json({ ok: true });
    }

    const email = validEmail(body.email);
    if (!email) return res.status(400).json({ error: 'invalid_email' });

    const source = ALLOWED_SOURCES.includes(String(body.source || '').trim())
      ? String(body.source).trim() : 'start';

    const ip = clientIp(req);
    if (await rateLimited('ip:' + hashWithSecret(ip))) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    const capturedAt = new Date().toISOString();
    const subjectHash = subjectFor(email);

    // Our own record first. This is where rung one is measured, whatever Resend
    // holds: so a Resend outage still leaves us the address.
    if (admin) {
      const { error } = await admin.from('captures').upsert({
        email,
        source,
        captured_at: capturedAt,
        ip_hash: hashWithSecret(ip),
        subject_hash: subjectHash,
      }, { onConflict: 'email' });
      if (error) console.warn('capture row not written:', error.message);
    }

    const contact = await upsertContact(email, source, capturedAt);
    console.log('capture contact:', JSON.stringify(contact));

    // 30 days, matching the library tokens. The subject is the hash, never the
    // address, so the link leaks nothing if it is forwarded.
    const token = mintToken(subjectHash, 30);
    const link = `${APP_BASE}/api/workbook-download?t=${encodeURIComponent(token)}`;

    const send = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: 'Your workbook is ready',
        html: deliveryHtml(link),
        headers: { 'List-Unsubscribe': '<mailto:contact@voicefirstdayplanner.com?subject=unsubscribe>' },
      }),
    });

    if (!send.ok) {
      const detail = (await send.text()).slice(0, 300);
      console.error('capture send failed:', send.status, detail);
      return res.status(502).json({ error: 'Sorry, something went wrong sending that. Please try again.' });
    }

    if (!contact.ok) console.warn('capture contact not stored in Resend:', JSON.stringify(contact));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('capture failed:', e.message);
    return res.status(502).json({ error: 'Sorry, something went wrong sending that. Please try again.' });
  }
}
