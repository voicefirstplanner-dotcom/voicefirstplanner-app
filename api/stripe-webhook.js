import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

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

const WELCOME_SUBJECT = 'Welcome to Lifetime — your whole library\u2019s inside.';

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
    .select('plan,source,status,founding_number')
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
  const current = await getEntitlement(userId);
  if (current?.source === 'lifetime') {
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

// One download row. If a URL is missing we render the title without a broken
// link rather than a dead <a> — a filled URL is a go-live pre-req, but a blank
// one should never produce a "click here -> nowhere".
function fileRow(title) {
  return `<li style="margin:6px 0;">${esc(title)}</li>`;
}

function renderWelcomeHtml(firstName) {
  const name = esc(firstName || 'there');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">Your Lifetime access, all eight workbooks, and the research — all in this email.</div>
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

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px;"><tr><td style="border-radius:8px;background:#0C447C;">
      <a href="${esc(APP_LIBRARY_URL)}" style="display:inline-block;padding:14px 28px;color:#FFFFFF;font-size:16px;font-weight:700;text-decoration:none;">Open your Library &rarr;</a>
    </td></tr></table>
    <p style="font-size:14px;line-height:1.5;color:#6b6b6b;margin:0 0 24px;">Sign in and every file below is waiting in Settings under <strong>Your Lifetime Library</strong>, ready to download.</p>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">Your two starter books</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('The Workbook')}
      ${fileRow('The Voice Command Guide')}
    </ul>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">The full Voice-First Life Planning System — all eight workbooks</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('Values — Busy Isn\u2019t the Same as Living Well')}
      ${fileRow('Goals — Wishing Isn\u2019t the Same as Deciding')}
      ${fileRow('Habits — Motivation Isn\u2019t the Same as Momentum')}
      ${fileRow('Bucket List — Someday Isn\u2019t the Same as a Plan')}
      ${fileRow('Projects — Effort Isn\u2019t the Same as Progress')}
      ${fileRow('Daily Planning — A Full Day Isn\u2019t the Same as a Good Day')}
      ${fileRow('Week Ahead — A Week Isn\u2019t the Same as Seven Days')}
      ${fileRow('Reflect — Experience Isn\u2019t the Same as Wisdom')}
    </ul>

    <p style="font-size:16px;font-weight:700;color:#0C447C;margin:0 0 4px;">The research</p>
    <ul style="font-size:16px;line-height:1.5;margin:0 0 20px;padding-left:20px;">
      ${fileRow('Why Planning This Way Works — the studies behind the whole system')}
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
async function sendWelcomeEmail({ to, firstName, idemKey }) {
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
      subject: WELCOME_SUBJECT,
      html: renderWelcomeHtml(firstName),
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
async function fireLifetimeWelcome(session, userId) {
  const to = session.customer_details?.email || session.customer_email;
  if (!to) { console.warn('No email on Lifetime session', session.id, '— welcome email skipped'); return; }
  const rawName = session.customer_details?.name || '';
  const firstName = rawName.trim().split(/\s+/)[0] || '';

  const won = await claimWelcomeEmailSend(userId);
  if (!won) { console.log('Welcome email already sent/claimed for', userId, '— skipping'); return; }

  try {
    await sendWelcomeEmail({ to, firstName, idemKey: `lifetime-welcome-${userId}` });
    console.log('Lifetime welcome email sent to', to, 'user=', userId);
  } catch (e) {
    console.error('Welcome email send failed for', userId, e.message);
    await releaseWelcomeEmailClaim(userId); // let a Stripe retry try again
    throw e;                                // -> 500 -> Stripe retries
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
        const userId = session.client_reference_id || session.metadata?.supabase_user_id;
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
          await fireLifetimeWelcome(session, userId);
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
        if (held?.source === 'lifetime') {
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
        let userId = null;
        if (charge.payment_intent) {
          try {
            const pi = await stripe.paymentIntents.retrieve(charge.payment_intent);
            userId = pi.metadata?.supabase_user_id || null;
          } catch (e) {
            console.warn('Could not retrieve PI for refunded charge', charge.id, e.message);
          }
        }
        if (!userId) userId = await findUserIdByCustomer(charge.customer);
        if (!userId) { console.warn('No user for refunded charge', charge.id); break; }

        // CONFIRM IT'S A LIFETIME CHARGE. The only durable Lifetime marker is the
        // entitlement source written by the purchase path — checkout tags no
        // 'lifetime' on the Stripe side. This is also the guard that makes us IGNORE
        // subscription refunds (their source is 'monthly'/'annual') and makes the
        // whole handler idempotent: once revoked, source is no longer 'lifetime', so
        // a replayed event finds nothing to do.
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
