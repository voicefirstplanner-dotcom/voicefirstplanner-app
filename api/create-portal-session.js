import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { signedInUser } from './_lib/signed-in.js';   // 31 Oct 2026: Groups step 0
import { bfSubState, bfStopRenewal, bfKeepRenewing } from './_lib/black-friday.js';   // 14 Nov 2026

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const APP_URL = process.env.APP_URL || 'https://app.voicefirstdayplanner.com';

// POST, signed in (Authorization: Bearer <access token>) -> { url } to the
// Stripe-hosted billing portal. 31 Oct 2026 (Groups step 0): the account is the
// SIGNED-IN one, never an id in the body. Before this, anyone who knew a
// member's id could open that member's billing page.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const me = await signedInUser(req, supabase);
    if (!me) return res.status(401).json({ error: 'Could not open billing — please try again' });
    const userId = me.id;   // any userId in the body is ignored

    let { data, error: readErr } = await supabase
      .from('entitlements')
      .select('stripe_customer_id,stripe_subscription_id,bf_paid_to,bf_route')
      .eq('user_id', userId)
      .maybeSingle();
    if (readErr) {
      // Before the Black Friday columns exist (SQL BF12), read what this always read, so billing keeps working.
      ({ data } = await supabase.from('entitlements').select('stripe_customer_id').eq('user_id', userId).maybeSingle());
    }

    // 14 Nov 2026 · Black Friday (F4): a Black Friday member paid once for two years; their yearly subscription is set
    // up to START when the two years end. Settings shows that, and stops (or restarts) it here. Their plan runs to the
    // end of the paid two years either way (Dave, 14 Nov). { action: 'bf_info' | 'bf_stop' | 'bf_keep' }, the
    // signed-in account's own only.
    const action = (req.body || {}).action;
    if (action === 'bf_info' || action === 'bf_stop' || action === 'bf_keep') {
      const st = await bfSubState(stripe, data);
      if (!st.bf) return res.status(200).json({ bf: false });
      if (action === 'bf_stop' && !st.stopping) await bfStopRenewal(stripe, st);
      if (action === 'bf_keep' && st.stopping) await bfKeepRenewing(stripe, st, { customerId: data.stripe_customer_id, userId });
      const now = action === 'bf_info' ? st : await bfSubState(stripe, data);
      let thenAmount = null;
      if (now.then_price) {
        try { const tp = await stripe.prices.retrieve(now.then_price); thenAmount = tp.unit_amount; } catch (e) {}
      }
      return res.status(200).json({ bf: true, route: now.route, paid_to: now.paid_to, stopping: now.stopping, then_amount: thenAmount });
    }

    if (!data?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found for this user' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: APP_URL,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-portal-session error:', err);
    return res.status(500).json({ error: err.message });
  }
}
