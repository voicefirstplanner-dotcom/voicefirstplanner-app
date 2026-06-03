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

async function findUserIdByCustomer(customerId) {
  if (!customerId) return null;
  const { data } = await supabase
    .from('entitlements')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data?.user_id || null;
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
          // One-off lifetime purchase — premium forever, no subscription.
          await upsertEntitlement({
            user_id: userId,
            plan: 'premium',
            source: 'lifetime',
            status: 'active',
            stripe_customer_id: customerId,
            stripe_subscription_id: null,
            current_period_end: null,
          });
        } else if (session.mode === 'subscription') {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const price = sub.items.data[0]?.price;
          const interval = price?.recurring?.interval; // 'month' | 'year'
          await upsertEntitlement({
            user_id: userId,
            plan: planFromPrice(price),
            source: interval === 'year' ? 'annual' : 'monthly',
            status: sub.status,
            stripe_customer_id: customerId,
            stripe_subscription_id: sub.id,
            current_period_end: periodEnd(sub),
          });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId =
          sub.metadata?.supabase_user_id || (await findUserIdByCustomer(sub.customer));
        if (!userId) {
          console.warn('No user mapped for subscription', sub.id);
          break;
        }
        const price = sub.items.data[0]?.price;
        const interval = price?.recurring?.interval;
        const active = ['active', 'trialing', 'past_due'].includes(sub.status);
        await upsertEntitlement({
          user_id: userId,
          plan: active ? planFromPrice(price) : 'free',
          source: interval === 'year' ? 'annual' : 'monthly',
          status: sub.status,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          current_period_end: periodEnd(sub),
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId =
          sub.metadata?.supabase_user_id || (await findUserIdByCustomer(sub.customer));
        if (!userId) break;
        // NOTE: simple model — a cancelled subscription drops the user to free.
        // When Pro + the $2 lifetime add-on ship, change this to only drop the
        // Pro add-on and keep lifetime Premium intact for those users.
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
