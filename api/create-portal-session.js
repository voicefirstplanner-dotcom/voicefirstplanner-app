import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { signedInUser } from './_lib/signed-in.js';   // 31 Oct 2026: Groups step 0

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

    const { data } = await supabase
      .from('entitlements')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .maybeSingle();

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
