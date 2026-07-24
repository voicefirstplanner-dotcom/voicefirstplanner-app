import { createClient } from '@supabase/supabase-js';
import { mintToken, downloadUrl } from './_lib/token.js';

// ---------------------------------------------------------------------------
// JOB 1 — WELCOME 0 ON EMAIL CONFIRMATION  (route: Supabase Database Webhook)
//
// Fires the moment auth.users.email_confirmed_at goes null -> not-null, i.e. the
// instant a free signup confirms their address. Sends Welcome 0 with per-user
// tokenised download links baked in, then the Resend Automation carries Welcomes
// 1–5 on their delays (Welcome 0 is removed from the Automation at cutover).
//
// WHY A DB WEBHOOK, not the app redirect: signUp() sets no emailRedirectTo and no
// post-confirmation handler exists, so a user who confirms on one device and signs
// in on another would never trigger a client-side hook. Firing off the database
// transaction itself is the only route that can't be missed by a closed tab.
//
// WHY CONFIRMATION, not signup: marketing mail to unverified addresses drives
// bounces; Resend pauses an account over ~4% bounce, which would take the
// transactional confirmation emails down too. So the sequence starts only once
// the address is proven real.
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Dave <dave@voicefirstdayplanner.com>';

// Shared secret the Supabase Database Webhook must present (as `Authorization:
// Bearer <secret>` or `x-webhook-secret: <secret>`). Without it this endpoint
// would let anyone trigger a welcome sequence to any confirmed address — an
// email-bomb / Resend-reputation risk. Dedicated secret; see the runbook.
const HOOK_SECRET = process.env.CONFIRM_HOOK_SECRET;

// B2: the published Welcome 0 template is fetched and its copy reused, so Dave
// keeps editing wording in the Resend dashboard. Only the download link hrefs
// are substituted server-side (Resend template variables can't safely carry a
// URL inside an <a href> over the REST path — hence server-side substitution).
const WELCOME0_TEMPLATE_ID = process.env.WELCOME0_TEMPLATE_ID || '84e94ece-926b-4498-8ab1-42977828d74a';

// Frozen placeholder hrefs sitting in the template. The code finds these and
// swaps in per-user tokenised links. DO NOT rename these in the template without
// telling the App Room — a renamed sentinel silently breaks substitution (the
// fail-loud fallback below catches it, but the dashboard copy would be bypassed).
const SENTINELS = {
  workbook: 'https://vfp.link/dl/workbook',
  guide:    'https://vfp.link/dl/guide',
};

const DL_BASE = (process.env.APP_URL || 'https://app.voicefirstdayplanner.com') + '/api/library-download';

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// href-safe tokenised URL (ampersands encoded for an HTML attribute).
function dlHref(token, doc) {
  return downloadUrl(DL_BASE, token, doc).replace(/&/g, '&amp;');
}

// Rewrite the href of an anchor whose visible text contains `textNeedle`.
// Safety net for the guide link if its sentinel wasn't set in the template.
function rewriteAnchorByText(html, textNeedle, newHref) {
  const re = new RegExp(
    '(<a\\b[^>]*href=")[^"]*("[^>]*>\\s*[^<]*' +
    textNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '[^<]*</a>)',
    'i'
  );
  return html.replace(re, `$1${newHref}$2`);
}

// Baked-in last-known-good Welcome 0 — sent ONLY if the fetched template can't be
// turned into a valid two-link email. Fail loud (log), don't fail silent (a
// broken or link-less email). Self-contained with working tokenised links.
function fallbackWelcome0Html(firstName, token) {
  const name = esc(firstName || 'there');
  const wb = dlHref(token, 'workbook');
  const gd = dlHref(token, 'guide');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#2C2C2A;">
  <tr><td style="background:#0C447C;height:6px;line-height:6px;">&nbsp;</td></tr>
  <tr><td style="padding:32px;">
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Hi ${name},</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">You're confirmed — welcome to VoiceFirstPlanner. Here are your two free books. They download straight from this email, and they're always in your Library under Settings too.</p>
    <ul style="font-size:16px;line-height:1.6;margin:0 0 20px;padding-left:20px;">
      <li style="margin:6px 0;"><a href="${wb}" style="color:#0C447C;font-weight:600;">Download the Workbook</a></li>
      <li style="margin:6px 0;"><a href="${gd}" style="color:#0C447C;font-weight:600;">Download the Voice Command Guide</a></li>
    </ul>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Then just tap the mic and talk — your day plans itself.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Dave</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Pure link substitution — no I/O, so it's unit-testable against the real code.
// Swaps the frozen sentinels for per-user tokenised links, with an anchor-text
// safety net for the guide. Returns { html, ok } where ok means BOTH download
// links are present and tokenised.
export function applyWelcome0Links(templateHtml, token) {
  const wb = dlHref(token, 'workbook');
  const gd = dlHref(token, 'guide');
  let html = String(templateHtml || '');

  // Primary: swap the frozen sentinels.
  if (html.includes(SENTINELS.workbook)) html = html.split(SENTINELS.workbook).join(wb);
  if (html.includes(SENTINELS.guide))    html = html.split(SENTINELS.guide).join(gd);

  // Safety net: if either link still isn't tokenised, rewrite by anchor text.
  if (!html.includes('doc=guide'))    html = rewriteAnchorByText(html, 'Voice Command Guide', gd);
  if (!html.includes('doc=workbook')) html = rewriteAnchorByText(html, 'Workbook', wb);

  const ok = html.includes('doc=workbook') && html.includes('doc=guide');
  return { html, ok };
}

// Build the Welcome 0 HTML from the published template (B2), or fall back.
// Returns { html, subject, usedFallback }.
async function buildWelcome0(firstName, token) {
  let subject = 'Your books are ready';
  try {
    const r = await fetch(`https://api.resend.com/templates/${WELCOME0_TEMPLATE_ID}`, {
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
    });
    if (!r.ok) throw new Error(`template fetch ${r.status}`);
    const tpl = await r.json();
    if (tpl?.subject) subject = tpl.subject;
    if (!tpl?.html || typeof tpl.html !== 'string') throw new Error('template html empty');

    const { html, ok } = applyWelcome0Links(tpl.html, token);
    if (ok) return { html, subject, usedFallback: false };

    console.error('Welcome0 substitution incomplete — using fallback');
  } catch (e) {
    console.error('Welcome0 template build failed:', e.message, '— using fallback');
  }
  return { html: fallbackWelcome0Html(firstName, token), subject, usedFallback: true };
}

// One-shot guard. INSERT ... ON CONFLICT DO NOTHING: exactly one caller inserts
// the row and gets it back; concurrent retries insert nothing and return []. This
// is the "fire once per user" guarantee — a duplicate webhook can't double-send
// the six-email sequence. (Table: public.welcome_confirm_sends — see runbook SQL.)
async function claimConfirmSend(userId) {
  const { data, error } = await supabase
    .from('welcome_confirm_sends')
    .insert({ user_id: userId })
    .select('user_id');
  if (error) {
    // 23505 = unique_violation => already sent. Anything else is a real error.
    if (error.code === '23505') return false;
    console.error('claimConfirmSend failed:', error.message);
    throw error;
  }
  return Array.isArray(data) && data.length === 1;
}

async function releaseConfirmClaim(userId) {
  const { error } = await supabase.from('welcome_confirm_sends').delete().eq('user_id', userId);
  if (error) console.error('confirm claim rollback failed:', error.message);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate the caller. Only the Supabase Database Webhook, carrying the
  // shared secret, may trigger a send.
  if (!HOOK_SECRET) {
    console.error('CONFIRM_HOOK_SECRET not set — refusing to run unauthenticated');
    return res.status(503).json({ error: 'Not configured' });
  }
  const authz = req.headers['authorization'] || '';
  const bearer = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  const presented = bearer || req.headers['x-webhook-secret'] || '';
  if (presented !== HOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body || {};
    const record = body.record || {};
    const oldRecord = body.old_record || {};

    // Must be a confirmation transition: was null, now set.
    const wasConfirmed = !!oldRecord.email_confirmed_at;
    const nowConfirmed = !!record.email_confirmed_at;
    if (wasConfirmed || !nowConfirmed) {
      return res.status(200).json({ skipped: 'not a confirmation transition' });
    }

    const userId = record.id;
    const to = record.email;
    if (!userId || !to) {
      return res.status(200).json({ skipped: 'no user id / email in record' });
    }

    // Fire once per user.
    let won;
    try {
      won = await claimConfirmSend(userId);
    } catch (e) {
      return res.status(500).json({ error: 'guard failed' }); // Supabase retries
    }
    if (!won) return res.status(200).json({ skipped: 'already sent' });

    const rawName = record.raw_user_meta_data?.name || '';
    const firstName = String(rawName).trim().split(/\s+/)[0] || '';
    const token = mintToken(userId); // 30-day per-user download token

    const { html, subject, usedFallback } = await buildWelcome0(firstName, token);

    const send = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `welcome0-${userId}`,
      },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
    });

    if (!send.ok) {
      const detail = await send.text().catch(() => '');
      console.error('Welcome0 send failed for', userId, send.status, detail.slice(0, 200));
      await releaseConfirmClaim(userId);            // let the webhook retry
      return res.status(500).json({ error: 'send failed' });
    }

    console.log('Welcome0 sent to', to, 'user=', userId, 'fallback=', usedFallback);
    return res.status(200).json({ ok: true, fallback: usedFallback });
  } catch (err) {
    console.error('user-confirmed error:', err);
    return res.status(500).json({ error: 'Handler error' });
  }
}
