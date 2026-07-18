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
