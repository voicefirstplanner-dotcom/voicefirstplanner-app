import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { mintToken, downloadUrl } from './_lib/token.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Stripe signature verification needs the RAW body, so turn off Vercel's parser.
export const config = { api: { bodyParser: false } };

// ---------------------------------------------------------------------------
// LIFETIME WELCOME EMAIL — config
// The email links members to the files they get. Fill these before go-live or
// the email ships with dead links. Sourced from env so URLs aren't hard-coded
// in the repo. The two Starter Books reuse the exact URLs the free-account
// welcome email already sends (see VFP_Lifetime_Welcome_Email_2026-07-20).
// ---------------------------------------------------------------------------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Dave Rees <dave@voicefirstdayplanner.com>';

// D25: files are delivered in-app through the gated /api/library-download endpoint,
// not by public links. The email links to the app; the member signs in and their
// Library serves each file behind the entitlement check. The old VFP_URL_* env vars
// are now OBSOLETE and can be removed from Vercel.
const APP_LIBRARY_URL = (process.env.APP_URL || 'https://app.voicefirstdayplanner.com') + '/#library';

// Base for tokenised per-file download links carried by welcome emails. A single
// per-user token identifies the member; the ?doc= selects the file. Entitlement
// is re-checked at download time in library-download.js, so these links reflect
// the member's CURRENT tier whenever they're clicked — not the tier at send time.
const DL_BASE = (process.env.APP_URL || 'https://app.voicefirstdayplanner.com') + '/api/library-download';

const WELCOME_SUBJECT = 'Welcome to Lifetime — your whole library\u2019s inside.';
const ANNUAL_SUBJECT = 'Welcome to Premium Annual — your books are inside.';
const MONTHLY_SUBJECT = 'You\u2019re on Premium — welcome aboard.';
const PRO_SUBJECT     = 'You\u2019re on Pro — the AI is yours.';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Map a Stripe price -> internal plan. When Pro launches, set price.metadata.plan = 'pro'
// on the Pro prices in the dashboard and this picks it up automatically.
function planFromPrice(price) {
  if (price?.metadata?.plan) return price.metadata.plan;
  return 'premium';
}

// Subscription period end moved between top-level and per-item across API versions; read both.
function periodEnd(sub) {
  const ts = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

async function upsertEntitlement(row) {
  const { error } = await supabase
    .from('entitlements')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) console.error('Supabase upsert error:', error);
}

// Read what we already hold for this user. Needed because some events must NOT
// blindly overwrite: a Lifetime member is premium forever regardless of what any
// subscription does afterwards.
async function getEntitlement(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('entitlements')
    .select('plan,source,status,founding_number,comp')
    .eq('user_id', userId)
    .maybeSingle();
  return data || null;
}

// Idempotent founding-number claim (cap 1,000). Calling it twice for the same user
// returns the SAME number rather than burning a second one — which matters because
// Stripe retries any non-2xx, and retries are routine, not exceptional.
async function claimFoundingNumber(userId) {
  try {
    const { data, error } = await supabase.rpc('claim_founding_number', { p_user_id: userId });
    if (error) { console.error('claim_founding_number failed:', error.message); return null; }
    if (data === null) console.warn('Founding numbers exhausted (1000) — user', userId, 'has Lifetime without one');
    return data;
  } catch (e) {
    console.error('claim_founding_number threw:', e.message);
    return null;   // never block the entitlement over a counter
  }
}

// Return a founding number to the pool on a Lifetime refund, so the next buyer
// re-uses it. MUST be idempotent at the DB level: the same charge.refunded event
// can arrive twice, and two concurrent deliveries can both pass the JS guard
// below, so the no-double-decrement guarantee has to live in Postgres, not here.
// (Companion to claim_founding_number — see release_founding_number.sql.)
async function releaseFoundingNumber(userId) {
  try {
    const { data, error } = await supabase.rpc('release_founding_number', { p_user_id: userId });
    if (error) { console.error('release_founding_number failed:', error.message); return null; }
    return data;
  } catch (e) {
    console.error('release_founding_number threw:', e.message);
    return null;
  }
}

async function findUserIdByCustomer(customerId) {
  if (!customerId) return null;
  const { data } = await supabase
    .from('entitlements')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data?.user_id || null;
}

// Write the entitlement for a subscription based on its CURRENT state.
// We re-fetch the subscription from Stripe rather than trusting the status frozen
// into the event, so out-of-order or replayed events (e.g. a stale "incomplete"
// subscription.created arriving AFTER the subscription is already active) can never
// downgrade an active subscriber back to free.
async function syncSubscriptionById(subscriptionId, fallbackSub) {
  let sub = fallbackSub || null;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (e) {
    console.warn('Could not re-fetch subscription, using event payload:', e.message);
  }
  if (!sub) return;

  const userId =
    sub.metadata?.supabase_user_id || (await findUserIdByCustomer(sub.customer));
  if (!userId) {
    console.warn('No user mapped for subscription', sub.id);
    return;
  }

  const price = sub.items?.data?.[0]?.price;
  const interval = price?.recurring?.interval; // 'month' | 'year'
  const active = ['active', 'trialing', 'past_due'].includes(sub.status);

  // LIFETIME IS FOREVER. A lifetime member who also holds (or once held) a
  // subscription must never be downgraded by it. Without this, an old monthly
  // lapsing would silently strip the Premium they paid $99 for — and, under the
  // Library, their books with it.
  //
  // Job 6 (10 Aug): with the founding-member Pro add-on, one subscription shape
  // now legitimately BELONGS to a Lifetime member. A pro-plan subscription
  // upgrades them to plan='pro' while active — source stays 'lifetime', which
  // is what every other guard keys off — and its lapse falls back to
  // plan='premium', source='lifetime'. NEVER to free. Any non-pro subscription
  // on a Lifetime account remains ignored exactly as before.
  const current = await getEntitlement(userId);
  // ⛔ COMP ACCOUNTS ARE UNTOUCHABLE BY STRIPE. A comp holds no Stripe objects,
  // so in principle no branch can reach it — but "in principle" is what cost two
  // founding entitlements in Job 6. This is explicit: if the account is comped,
  // no subscription state may rewrite it, in any event order.
  if (current?.comp === true) {
    console.log('Comp account', userId, '— subscription', sub.id, sub.status, 'ignored for entitlement');
    return;
  }
  if (current?.source === 'lifetime') {
    if (planFromPrice(price) === 'pro') {
      await upsertEntitlement({
        user_id: userId,
        plan: active ? 'pro' : 'premium',
        source: 'lifetime',
        status: active ? sub.status : 'active',
        stripe_customer_id: sub.customer,
        stripe_subscription_id: sub.id,
        current_period_end: active ? periodEnd(sub) : null,
      });
      console.log('Lifetime member', userId, '— founding Pro subscription', sub.id, sub.status, active ? '=> plan=pro' : '=> back to lifetime premium');
      return;
    }
    console.log('Lifetime member', userId, '— subscription', sub.id, sub.status, 'ignored for entitlement');
    return;
  }

  await upsertEntitlement({
    user_id: userId,
    plan: active ? planFromPrice(price) : 'free',
    source: interval === 'year' ? 'annual' : 'monthly',
    status: sub.status,
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    current_period_end: periodEnd(sub),
  });
}

// ---------------------------------------------------------------------------
// LIFETIME WELCOME EMAIL — send
// ---------------------------------------------------------------------------

// Atomically claim the exclusive right to send ONE welcome email to this user.
// The `.is('welcome_email_sent_at', null)` guard means only the first caller
// matches a row; concurrent Stripe retries update zero rows and return false.
// This is the idempotency guarantee — one email per member, however many times
// the event is delivered.
async function claimWelcomeEmailSend(userId) {
  const { data, error } = await supabase
    .from('entitlements')
    .update({ welcome_email_sent_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('welcome_email_sent_at', null)
    .select('user_id');
  if (error) { console.error('welcome-email claim failed:', error.message); return false; }
  return Array.isArray(data) && data.length === 1;
}

// Release the claim so a Stripe retry can attempt the send again — used only
// when the Resend call itself fails after we'd already claimed.
async function releaseWelcomeEmailClaim(userId) {
  const { error } = await supabase
    .from('entitlements')
    .update({ welcome_email_sent_at: null })
    .eq('user_id', userId);
  if (error) console.error('welcome-email claim rollback failed:', error.message);
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// One download row. With a URL it renders a real download link; without one it
// renders the title as plain text rather than a dead <a> — so a missing link is
// never a "click here -> nowhere".
function fileRow(title, url) {
  const label = esc(title);
  if (!url) return `<li style="margin:6px 0;">${label}</li>`;
  return `<li style="margin:6px 0;"><a href="${esc(url)}" style="color:#0C447C;font-weight:600;">${label}</a></li>`;
}

function renderWelcomeHtml(firstName, token) {
  const name = esc(firstName || 'there');
  const dl = (doc) => downloadUrl(DL_BASE, token, doc);
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">Your Lifetime access, your three books, all eight workbooks, and the research — all in this email.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#2C2C2A;">
  <tr><td style="background:#0C447C;height:6px;line-height:6px;">&nbsp;</td></tr>
  <tr><td style="padding:32px 32px 8px 32px;">
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Hi ${name},</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">You're in — and not just in. You're one of only <strong>1,000 founding Lifetime members</strong>, and that door doesn't open again. When these are gone, the offer's gone for good. So thank you for not waiting to make up your mind.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Here's everything that comes with it. Save this email — it's your set of keys.</p>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">Your Premium account, for life</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Every planning feature, no subscription, ever. Sign in any time at <a href="https://app.voicefirstdayplanner.com" style="color:#0C447C;font-weight:600;">app.voicefirstdayplanner.com</a> — you're already Premium.</p>

    <p style="font-size:14px;line-height:1.5;color:#6b6b6b;margin:0 0 24px;">Every file below downloads straight from this email — no login needed. They also live in your <a href="${esc(APP_LIBRARY_URL)}" style="color:#0C447C;font-weight:600;">Library</a> any time, under Settings. <em>(Download links in this email stay live for 30 days; after that, grab anything from your Library.)</em></p>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">Your three books</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('The VoiceFirstPlanner Instruction Manual', dl('manual'))}
      ${fileRow('The VoiceFirstPlanner Voice Command Guide', dl('guide'))}
      ${fileRow('The Voice First Life Planning System \u2014 Starter Workbook', dl('workbook'))}
    </ul>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">The full Voice-First Life Planning System — all eight workbooks</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('Values — Busy Isn\u2019t the Same as Living Well', dl('values'))}
      ${fileRow('Goals — Wishing Isn\u2019t the Same as Deciding', dl('goals'))}
      ${fileRow('Habits — Motivation Isn\u2019t the Same as Momentum', dl('habits'))}
      ${fileRow('Bucket List — Someday Isn\u2019t the Same as a Plan', dl('bucket'))}
      ${fileRow('Projects — Effort Isn\u2019t the Same as Progress', dl('projects'))}
      ${fileRow('Daily Planning — A Full Day Isn\u2019t the Same as a Good Day', dl('daily'))}
      ${fileRow('Week Ahead — A Week Isn\u2019t the Same as Seven Days', dl('week'))}
      ${fileRow('Reflect — Experience Isn\u2019t the Same as Wisdom', dl('reflect'))}
    </ul>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">The research</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('Why Planning This Way Works — the studies behind the whole system', dl('research'))}
    </ul>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">And going forward</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">As a founding member you get <strong>up to 75% off</strong> every new digital product we ever release, and <strong>first access</strong> to all of it. When there's something new, you'll be the first to hear.</p>

    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">That's the lot. Start wherever you like — but if you want my honest suggestion, open Values first. Everything else in the system hangs off knowing what actually matters to you.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Any trouble getting into anything, just reply to this email — it comes to me.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Welcome aboard.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Dave</p>
    <p style="font-size:13px;line-height:1.5;color:#6b6b6b;margin:0 0 2px;"><em>Dave Rees — From boatbuilder, to business owner, to Founder.</em></p>
    <p style="font-size:13px;line-height:1.5;color:#6b6b6b;margin:0 0 24px;"><em>When you're organized, the stress goes out of your day.</em></p>
  </td></tr>
  <tr><td style="background:#E6F1FB;padding:14px 32px;font-size:12px;color:#6b6b6b;">VoiceFirstPlanner · You're receiving this because you purchased Lifetime access.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Send via the Resend REST API (no SDK dependency). Idempotency-Key is a second
// line of defence behind the DB claim above. Throws on failure so the caller can
// roll back the claim and let Stripe retry.
async function sendEmail({ to, subject, html, idemKey }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

// Fire-the-welcome-email step for a confirmed Lifetime purchase. Isolated so the
// purchase path stays readable. Claims the send, sends, rolls back + rethrows on
// failure so the whole event 500s and Stripe retries (entitlement writes above
// are idempotent, so a retry is harmless).
// Comp accounts (14 Aug): this takes SCALARS, not a Stripe session, so the exact
// same function — same template, same token, same idempotency claim — serves both
// the paid path and a comp grant. One design, one source: there is no second
// template to drift when this one is edited. The webhook passes what it always
// read off the session; api/comp-welcome.js passes what it read off the account.
export async function fireLifetimeWelcome(userId, to, firstName) {
  if (!to) { console.warn('No email for Lifetime welcome, user', userId, '— skipped'); return; }
  firstName = String(firstName || '').trim().split(/\s+/)[0] || '';

  const won = await claimWelcomeEmailSend(userId);
  if (!won) { console.log('Welcome email already sent/claimed for', userId, '— skipping'); return; }

  try {
    const token = mintToken(userId); // 30-day per-user download token
    await sendEmail({
      to,
      subject: WELCOME_SUBJECT,
      html: renderWelcomeHtml(firstName, token),
      idemKey: `lifetime-welcome-${userId}`,
    });
    console.log('Lifetime welcome email sent to', to, 'user=', userId);
  } catch (e) {
    console.error('Welcome email send failed for', userId, e.message);
    await releaseWelcomeEmailClaim(userId); // let a Stripe retry try again
    throw e;                                // -> 500 -> Stripe retries
  }
}

// ---------------------------------------------------------------------------
// SUBSCRIPTION WELCOMES — Annual (delivers its 6 files) and Monthly (thank-you)
//
// Neither fired before this build: subscription checkouts only synced the
// entitlement and sent nothing, so an Annual buyer received none of the 4 extra
// files they'd paid for. Both now fire once, on the purchase checkout, guarded
// by the SAME welcome_email_sent_at claim as Lifetime (one onboarding email per
// member). Annual carries tokenised links for its 6 items; Monthly carries no
// downloads — its entitlement is the 2 Starter Books the free Welcome 0 already
// delivered — so it's a plain thank-you and stays clear of any link handling.
// ---------------------------------------------------------------------------

function renderAnnualHtml(firstName, token) {
  const name = esc(firstName || 'there');
  const dl = (doc) => downloadUrl(DL_BASE, token, doc);
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">Your Premium Annual books — the research paper and the Values, Goals and Habits workbooks — are in this email.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#2C2C2A;">
  <tr><td style="background:#0C447C;height:6px;line-height:6px;">&nbsp;</td></tr>
  <tr><td style="padding:32px 32px 8px 32px;">
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Hi ${name},</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">You're on <strong>Premium Annual</strong> — every planning feature, all year. Thank you.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Annual comes with more than the app. Here are the books that come with it — they download straight from this email, no login. They also live in your <a href="${esc(APP_LIBRARY_URL)}" style="color:#0C447C;font-weight:600;">Library</a> under Settings. <em>(Links stay live for 30 days.)</em></p>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">Your three books</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('The VoiceFirstPlanner Instruction Manual', dl('manual'))}
      ${fileRow('The VoiceFirstPlanner Voice Command Guide', dl('guide'))}
      ${fileRow('The Voice First Life Planning System \u2014 Starter Workbook', dl('workbook'))}
    </ul>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">Your Annual workbooks</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('Values — Busy Isn\u2019t the Same as Living Well', dl('values'))}
      ${fileRow('Goals — Wishing Isn\u2019t the Same as Deciding', dl('goals'))}
      ${fileRow('Habits — Motivation Isn\u2019t the Same as Momentum', dl('habits'))}
    </ul>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">The research</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('Why Planning This Way Works — the studies behind the whole system', dl('research'))}
    </ul>

    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Start wherever you like — but if you want my honest suggestion, open Values first. Everything else hangs off knowing what actually matters to you.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Any trouble getting into anything, just reply — it comes to me.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Dave</p>
    <p style="font-size:13px;line-height:1.5;color:#6b6b6b;margin:0 0 24px;"><em>When you're organized, the stress goes out of your day.</em></p>
  </td></tr>
  <tr><td style="background:#E6F1FB;padding:14px 32px;font-size:12px;color:#6b6b6b;">VoiceFirstPlanner · You're receiving this because you started a Premium Annual subscription.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function renderMonthlyHtml(firstName) {
  const name = esc(firstName || 'there');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">You're on Premium — every planning feature is unlocked.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#2C2C2A;">
  <tr><td style="background:#0C447C;height:6px;line-height:6px;">&nbsp;</td></tr>
  <tr><td style="padding:32px 32px 8px 32px;">
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Hi ${name},</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">You're on <strong>Premium</strong> — thank you. Every planning feature is now unlocked, with no daily limits.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="border-radius:8px;background:#0C447C;">
      <a href="https://app.voicefirstdayplanner.com" style="display:inline-block;padding:14px 28px;color:#FFFFFF;font-size:16px;font-weight:700;text-decoration:none;">Open the app &rarr;</a>
    </td></tr></table>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Your three books are already in your <a href="${esc(APP_LIBRARY_URL)}" style="color:#0C447C;font-weight:600;">Library</a>, under Settings, whenever you want them.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Any questions, just reply — it comes to me.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Dave</p>
    <p style="font-size:13px;line-height:1.5;color:#6b6b6b;margin:0 0 24px;"><em>When you're organized, the stress goes out of your day.</em></p>
  </td></tr>
  <tr><td style="background:#E6F1FB;padding:14px 32px;font-size:12px;color:#6b6b6b;">VoiceFirstPlanner · You're receiving this because you started a Premium subscription.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function renderProHtml(firstName) {
  const name = esc(firstName || 'there');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">You're on Pro — the AI brain-dump is unlocked.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#2C2C2A;">
  <tr><td style="background:#0C447C;height:6px;line-height:6px;">&nbsp;</td></tr>
  <tr><td style="padding:32px 32px 8px 32px;">
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Hi ${name},</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">You're on <strong>Pro</strong> — thank you. Every planning feature is unlocked, and so is the <strong>AI brain-dump</strong>: say everything on your mind, and it comes back sorted into tasks and appointments for your approval. Nothing enters your planner until you say so.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="border-radius:8px;background:#0C447C;">
      <a href="https://app.voicefirstdayplanner.com" style="display:inline-block;padding:14px 28px;color:#FFFFFF;font-size:16px;font-weight:700;text-decoration:none;">Open the app &rarr;</a>
    </td></tr></table>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Look for the sparkle button under your Daily Focus. Your three books are in your <a href="${esc(APP_LIBRARY_URL)}" style="color:#0C447C;font-weight:600;">Library</a>, under Settings.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Any questions, just reply — it comes to me.</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 4px;">Dave</p>
    <p style="font-size:13px;line-height:1.5;color:#6b6b6b;margin:0 0 24px;"><em>When you're organized, the stress goes out of your day.</em></p>
  </td></tr>
  <tr><td style="background:#E6F1FB;padding:14px 32px;font-size:12px;color:#6b6b6b;">VoiceFirstPlanner · You're receiving this because you started a Pro subscription.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Fire the right subscription welcome once, after the entitlement is synced.
// Reads the CURRENT entitlement to branch annual vs monthly and to confirm the
// subscription is actually active before welcoming (never welcome an incomplete
// or failed first payment). Lifetime members are skipped defensively. Guarded by
// the shared welcome_email_sent_at claim; rolls back + rethrows on send failure
// so Stripe retries (entitlement writes are idempotent).
async function fireSubscriptionWelcome(session, userId) {
  const to = session.customer_details?.email || session.customer_email;
  if (!to) { console.warn('No email on subscription session', session.id, '— welcome skipped'); return; }
  const rawName = session.customer_details?.name || '';
  const firstName = rawName.trim().split(/\s+/)[0] || '';

  const held = await getEntitlement(userId);
  if (held?.source === 'lifetime') return;                 // never downgrade the message
  const isActive = ['premium', 'pro'].includes(held?.plan);
  if (!isActive) {
    console.log('Subscription for', userId, 'not active yet (', held?.plan, ') — welcome deferred');
    return;
  }

  const won = await claimWelcomeEmailSend(userId);
  if (!won) { console.log('Welcome already sent/claimed for', userId, '— skipping'); return; }

  try {
    if (held.plan === 'pro') {
      // Pro (monthly or annual): the Pro welcome. No book links — what Pro
      // adds to the Library is an open Management decision; until it is made
      // the email promises nothing beyond what is live.
      await sendEmail({
        to,
        subject: PRO_SUBJECT,
        html: renderProHtml(firstName),
        idemKey: `pro-welcome-${userId}`,
      });
      console.log('Pro welcome sent to', to, 'user=', userId);
    } else if (held.source === 'annual') {
      const token = mintToken(userId);
      await sendEmail({
        to,
        subject: ANNUAL_SUBJECT,
        html: renderAnnualHtml(firstName, token),
        idemKey: `annual-welcome-${userId}`,
      });
      console.log('Annual welcome sent to', to, 'user=', userId);
    } else {
      // monthly (or any non-annual active subscription) -> plain thank-you
      await sendEmail({
        to,
        subject: MONTHLY_SUBJECT,
        html: renderMonthlyHtml(firstName),
        idemKey: `monthly-welcome-${userId}`,
      });
      console.log('Monthly thank-you sent to', to, 'user=', userId);
    }
  } catch (e) {
    console.error('Subscription welcome send failed for', userId, e.message);
    await releaseWelcomeEmailClaim(userId);
    throw e; // -> 500 -> Stripe retries
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method not allowed');
  }

  let event;
  try {
    const raw = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // Buyer identity travels in metadata.supabase_user_id (set at checkout).
        // client_reference_id is NO LONGER read here — it now carries the Rewardful
        // referral id, not the user id (see create-checkout-session.js).
        const userId = session.metadata?.supabase_user_id;
        const customerId = session.customer;
        if (!userId) {
          console.warn('No supabase_user_id on checkout session', session.id);
          break;
        }

        if (session.mode === 'payment') {
          // One-off Lifetime purchase.
          // plan='premium' + source='lifetime' — NEVER plan='lifetime'. The app's
          // isPremium() only recognises 'premium' and 'pro', so plan='lifetime'
          // would gate a paying founding member as free. `plan` is what you can do;
          // `source` is what you paid. (CORE BLOCK v23.)
          await upsertEntitlement({
            user_id: userId,
            plan: 'premium',
            source: 'lifetime',
            status: 'active',
            stripe_customer_id: customerId,
            stripe_subscription_id: null,
            current_period_end: null,
          });
          // Entitlement first, number second: if the counter ever fails, the member
          // still owns what they bought. A missing founding number is an admin job;
          // a missing entitlement is a locked-out customer.
          const n = await claimFoundingNumber(userId);
          console.log('Lifetime purchase user=%s founding_number=%s session=%s', userId, n, session.id);

          // Member is fully provisioned — now deliver their files by email.
          // The session's own fields, read here rather than inside the sender.
          await fireLifetimeWelcome(
            userId,
            session.customer_details?.email || session.customer_email,
            session.customer_details?.name || ''
          );
        } else if (session.mode === 'subscription') {
          // Seed the row so the customer -> user mapping exists, then sync the
          // subscription's CURRENT state (premium/active when paid).
          await upsertEntitlement({
            user_id: userId,
            plan: 'free',
            status: 'incomplete',
            stripe_customer_id: customerId,
            stripe_subscription_id: session.subscription,
          });
          await syncSubscriptionById(session.subscription);
          // Entitlement is now synced to its current state — deliver the right
          // welcome (Annual: its 6 files; Monthly: a thank-you).
          await fireSubscriptionWelcome(session, userId);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await syncSubscriptionById(sub.id, sub);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId =
          sub.metadata?.supabase_user_id || (await findUserIdByCustomer(sub.customer));
        if (!userId) break;
        // ⛔ A cancelled subscription must never touch a Lifetime member. They paid
        // once, for forever. Before this guard, any lapsed monthly/annual would set
        // plan='free' and strip the Premium (and, under the Library, the books) they
        // own outright.
        const held = await getEntitlement(userId);
        if (held?.comp === true) {
          console.log('Comp account', userId, '— subscription', sub.id, 'cancelled; entitlement untouched');
          break;
        }
        if (held?.source === 'lifetime') {
          // Job 6 (10 Aug): a founding member cancelling the Pro add-on falls
          // back to Lifetime Premium — the entitlement they bought outright —
          // never to free, and never left on Pro they no longer pay for.
          if (held.plan === 'pro') {
            await upsertEntitlement({
              user_id: userId,
              plan: 'premium',
              source: 'lifetime',
              status: 'active',
              stripe_subscription_id: null,
              current_period_end: null,
            });
            console.log('Lifetime member', userId, '— founding Pro', sub.id, 'cancelled => back to lifetime premium');
            break;
          }
          console.log('Lifetime member', userId, '— subscription', sub.id, 'cancelled; entitlement untouched');
          break;
        }
        await upsertEntitlement({
          user_id: userId,
          plan: 'free',
          status: 'canceled',
          stripe_subscription_id: sub.id,
        });
        break;
      }

      case 'charge.refunded': {
        // A Lifetime purchase is a one-off charge, not a subscription, so a refund
        // fires HERE — not subscription.deleted. Without this, refund the $99 and
        // the member keeps Premium forever. (CORE BLOCK v24 open item.)
        const charge = event.data.object;

        // Resolve the user: the payment_intent carries supabase_user_id (set at
        // checkout, payment_intent_data.metadata), with the customer map as fallback.
        // Job 6c: uidFromPI is tracked separately — it doubles as the POSITIVE
        // identification of the Lifetime one-off below.
        let uidFromPI = null;
        if (charge.payment_intent) {
          try {
            const pi = await stripe.paymentIntents.retrieve(charge.payment_intent);
            uidFromPI = pi.metadata?.supabase_user_id || null;
          } catch (e) {
            console.warn('Could not retrieve PI for refunded charge', charge.id, e.message);
          }
        }
        const userId = uidFromPI || (await findUserIdByCustomer(charge.customer));
        if (!userId) { console.warn('No user for refunded charge', charge.id); break; }

        // ⛔ POSITIVE IDENTIFICATION, OR NOTHING. Job 6c (10 Aug, second live
        // incident): the 6b guard tested charge.invoice — a field Stripe REMOVED
        // from the charge object on this account's API version (2026-05-27),
        // proven from the delivered event payload, which carries no invoice key
        // at all. The guard could never fire, and the $3.25 founding-Pro refund
        // revoked a Lifetime account for the second time.
        //
        // This guard now rests only on data WE wrote: our Lifetime checkout puts
        // supabase_user_id into payment_intent_data.metadata, so the one-off's
        // PI carries it (verified on the live July $99 charges) and a
        // subscription's PI does not (verified on the live $3.25 charge —
        // "Metadata: none"). A charge is treated as the Lifetime one-off ONLY
        // when identified by our own PI metadata; everything else is logged and
        // the entitlement is NEVER touched — in any event order,
        // subscription.deleted owns subscription state and nothing here can
        // contradict it. Belt: a description beginning "Subscription" is
        // subscription billing regardless.
        const comped = await getEntitlement(userId);
        if (comped?.comp === true) {
          console.log('Comp account', userId, '— refund on charge', charge.id, 'ignored; entitlement untouched');
          break;
        }
        const isLifetimeOneOff = !!uidFromPI && !String(charge.description || '').startsWith('Subscription');
        if (!isLifetimeOneOff) {
          console.log('Refund on non-one-off charge', charge.id, 'user', userId,
            '— entitlement untouched (positive Lifetime identification required; subscription.deleted owns subscription state)');
          break;
        }
        // Secondary guard (idempotency + non-Lifetime one-offs): once revoked,
        // source is no longer 'lifetime', so a replayed event finds nothing to do.
        const held = await getEntitlement(userId);
        if (held?.source !== 'lifetime') {
          console.log('Refund on non-Lifetime / already-revoked charge', charge.id, 'user', userId, '— ignored');
          break;
        }

        // FULL refund only. A partial refund of the $99 leaves Premium in place.
        // FLAG (Dave): partial-refund policy is undefined — see handoff. If partials
        // should revoke or prorate, that's a separate rule; today they no-op.
        const fullyRefunded = charge.refunded === true || charge.amount_refunded >= charge.amount;
        if (!fullyRefunded) {
          console.log('Partial refund on Lifetime charge', charge.id, 'user', userId,
            `(${charge.amount_refunded}/${charge.amount}) — no entitlement change (partial policy pending)`);
          break;
        }

        // Revoke: back to free, clear the lifetime marker. isPremium() gates on
        // premium|pro, so moving plan off 'premium' is what removes access.
        await upsertEntitlement({
          user_id: userId,
          plan: 'free',
          source: null,
          status: 'refunded',
        });
        // Return the founding seat to the pool for the next buyer. Idempotent at the
        // DB level (see release_founding_number.sql) so a double-delivered refund
        // can't double-free.
        const freed = await releaseFoundingNumber(userId);
        console.log('Lifetime refunded user=%s charge=%s founding_released=%s', userId, charge.id, freed);
        break;
      }

      default:
        // Other event types are safe to ignore.
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Handler error' }); // 500 => Stripe will retry
  }

  return res.status(200).json({ received: true });
}
