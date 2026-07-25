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

// Delivery mode for Welcome 0:
//   'template' (default) = B2: fetch the published Resend template, substitute
//                          links, and fall back to the baked design if that fails.
//   'baked'              = B1: skip the dashboard entirely and send the
//                          code-owned design below (always correct, no fetch).
// Set WELCOME0_MODE=baked in Vercel to flip. See the diagnosis note for the
// trade-off (dashboard-editable copy vs. zero fetch fragility).
const WELCOME0_MODE = (process.env.WELCOME0_MODE || 'template').toLowerCase();

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

// Rewrite the href of an anchor whose text contains `textNeedle` — the safety net
// when a sentinel href isn't present (e.g. the guide link, or a fetched version
// that predates the sentinel edit). Tolerates nested markup inside the anchor
// (visual-editor buttons wrap their label in <span>/<strong>), matching any
// content up to the closing </a> rather than assuming a flat text node.
function rewriteAnchorByText(html, textNeedle, newHref) {
  const n = textNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '(<a\\b[^>]*href=")[^"]*("[^>]*>(?:(?!</a>)[\\s\\S])*?' + n + '(?:(?!</a>)[\\s\\S])*?</a>)',
    'i'
  );
  return html.replace(re, `$1${newHref}$2`);
}

// The code-owned Welcome 0 — a faithful build of the intended design (post-
// confirmation intro, the two book downloads, and the "add to Home Screen" block
// that Job 2 strips out of the Supabase confirmation email). Used as the primary
// email in 'baked' mode, and as the fallback in 'template' mode — so a fallback
// is a fully-styled email, never a degraded one. Links are tokenised directly.
export function bakedWelcome0Html(firstName, token) {
  const name = esc(firstName || 'there');
  const wb = dlHref(token, 'workbook');
  const gd = dlHref(token, 'guide');
  const APP = 'https://app.voicefirstdayplanner.com';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">Your free Workbook and Voice Command Guide are ready \u2014 download them right here.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#2C2C2A;">
  <tr><td style="background:#0C447C;height:6px;line-height:6px;">&nbsp;</td></tr>
  <tr><td style="padding:32px 32px 8px 32px;">
    <h1 style="font-size:22px;line-height:1.3;color:#0C447C;margin:0 0 12px;">You\u2019re all set, ${name} \u2014 welcome to VoiceFirstPlanner</h1>
    <p style="font-size:16px;line-height:1.5;margin:0 0 24px;">Your email\u2019s confirmed and your free account is ready. Here\u2019s everything to get you started.</p>

    <div style="border-top:1px solid #E2E8F0;margin:0 0 24px;line-height:1px;font-size:1px;">&nbsp;</div>

    <h2 style="font-size:17px;color:#0C447C;margin:0 0 8px;">Your free workbook and command guide are ready</h2>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Ten guided worksheets to plan your whole life \u2014 values, goals, habits, dreams and every day \u2014 plus the full Voice Command Guide so you always know what to say. Both free with your account.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr><td style="border:1.5px solid #0C447C;border-radius:26px;">
      <a href="${wb}" style="display:inline-block;padding:12px 26px;color:#0C447C;font-size:15px;font-weight:700;text-decoration:none;">Download the Workbook</a>
    </td></tr></table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td style="border:1.5px solid #0C447C;border-radius:26px;">
      <a href="${gd}" style="display:inline-block;padding:12px 26px;color:#0C447C;font-size:15px;font-weight:700;text-decoration:none;">Download the Voice Command Guide</a>
    </td></tr></table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FB;border-left:4px solid #F26A21;border-radius:4px;margin:0 0 24px;">
      <tr><td style="padding:20px 22px;">
        <h2 style="font-size:17px;line-height:1.3;color:#0C447C;margin:0 0 10px;">Get the full experience \u2014 add it to your Home Screen</h2>
        <p style="font-size:15px;line-height:1.5;margin:0 0 16px;">VoiceFirstPlanner works right in your browser, but it\u2019s even better on your Home Screen \u2014 it opens full-screen like a real app, with a tap-to-open icon so your planner is always one tap away. It takes about ten seconds:</p>

        <p style="font-size:15px;font-weight:700;margin:0 0 6px;">On iPhone (Safari)</p>
        <ol style="font-size:15px;line-height:1.5;margin:0 0 16px;padding-left:20px;">
          <li>Open <a href="${APP}" style="color:#0C447C;">app.voicefirstdayplanner.com</a> in Safari.</li>
          <li>Tap the <strong>Share</strong> button (the square with an up-arrow).</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong> \u2014 then open it from your new icon.</li>
        </ol>

        <p style="font-size:15px;font-weight:700;margin:0 0 6px;">On Android (Chrome)</p>
        <ol style="font-size:15px;line-height:1.5;margin:0 0 16px;padding-left:20px;">
          <li>Open <a href="${APP}" style="color:#0C447C;">app.voicefirstdayplanner.com</a> in Chrome.</li>
          <li>Tap the <strong>\u22ee menu</strong> (top-right).</li>
          <li>Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</li>
          <li>Tap <strong>Install / Add</strong> \u2014 then open it from your new icon.</li>
        </ol>

        <p style="font-size:15px;line-height:1.5;margin:0;font-style:italic;">Then just tap the mic and talk \u2014 your day plans itself.</p>
      </td></tr>
    </table>

    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Any trouble getting in, just reply to this email \u2014 it comes to me.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Dave</p>
    <p style="font-size:13px;line-height:1.5;color:#6b6b6b;margin:0 0 24px;"><em>When you\u2019re organized, the stress goes out of your day.</em></p>
  </td></tr>
  <tr><td style="background:#E6F1FB;padding:14px 32px;font-size:12px;color:#6b6b6b;">VoiceFirstPlanner \u00b7 You\u2019re receiving this because you created a free account.</td></tr>
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

// Build the Welcome 0 HTML. Returns { html, subject, mode } where mode is
// 'baked' (B1 chosen), 'template' (B2 fetch+substitute worked), or 'fallback'
// (B2 attempted, failed, baked design sent instead). The log line this produces
// is the authoritative diagnosis for any test — read `mode=` first.
async function buildWelcome0(firstName, token) {
  const DEFAULT_SUBJECT = 'Your books are ready';

  // B1: baked is the primary. Not a fallback — always correct, no fetch.
  if (WELCOME0_MODE === 'baked') {
    return { html: bakedWelcome0Html(firstName, token), subject: DEFAULT_SUBJECT, mode: 'baked' };
  }

  // B2: fetch the published template and substitute links.
  let subject = DEFAULT_SUBJECT;
  try {
    const r = await fetch(`https://api.resend.com/templates/${WELCOME0_TEMPLATE_ID}`, {
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
    });
    if (!r.ok) {
      // Include status AND body so a permission problem (401/403 from a send-only
      // key) is instantly distinguishable from a bad ID (404).
      const body = await r.text().catch(() => '');
      throw new Error(`template fetch ${r.status} ${body.slice(0, 140)}`);
    }
    const tpl = await r.json();
    if (tpl?.subject) subject = tpl.subject;

    // Diagnostic: report exactly what came back, so a fallback is never a mystery
    // and a draft-vs-published version issue is visible in one line.
    const htmlStr = typeof tpl?.html === 'string' ? tpl.html : '';
    const hasWb = htmlStr.includes(SENTINELS.workbook);
    const hasGd = htmlStr.includes(SENTINELS.guide);
    console.log('Welcome0 template fetched: status=%s unpublished=%s sentinels(wb=%s gd=%s) htmlLen=%s',
      tpl?.status, tpl?.has_unpublished_versions, hasWb, hasGd, htmlStr.length);

    if (!htmlStr) throw new Error('template html empty');

    const { html, ok } = applyWelcome0Links(htmlStr, token);
    if (ok) return { html, subject, mode: 'template' };

    console.error('Welcome0 substitution incomplete (wb-sentinel=%s gd-sentinel=%s) — sending baked design', hasWb, hasGd);
  } catch (e) {
    console.error('Welcome0 template build failed:', e.message, '— sending baked design');
  }
  return { html: bakedWelcome0Html(firstName, token), subject, mode: 'fallback' };
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

    const { html, subject, mode } = await buildWelcome0(firstName, token);

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

    console.log('Welcome0 sent to', to, 'user=', userId, 'mode=', mode);
    return res.status(200).json({ ok: true, mode });
  } catch (err) {
    console.error('user-confirmed error:', err);
    return res.status(500).json({ error: 'Handler error' });
  }
}
