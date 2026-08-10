import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'https://app.voicefirstdayplanner.com';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Job 6: founding-member Pro prices — Lifetime accounts ONLY. Stripe cannot
// restrict a price to a customer, so the restriction lives here: any checkout
// for these prices is refused unless the buyer's entitlement says
// source==='lifetime'. The app never offers them to anyone else, but the UI
// is presentation — this refusal is the gate.
const FOUNDING_PRICES = new Set([
  'price_1U2ma81EGD58JnWm32aa4L2V',   // $3.25/mo  · metadata plan=pro
  'price_1U2mdU1EGD58JnWm7MtGbyG4',   // $22.25/yr · metadata plan=pro
]);

// POST { priceId, userId, email }
// Returns { url } — redirect the browser to it.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { priceId, userId, email, referral } = req.body || {};
    if (!priceId) return res.status(400).json({ error: 'Missing priceId' });

    if (FOUNDING_PRICES.has(priceId)) {
      if (!userId) return res.status(403).json({ error: 'founding_rate_lifetime_only' });
      const { data: ent } = await supabase
        .from('entitlements')
        .select('source')
        .eq('user_id', userId)
        .maybeSingle();
      if (ent?.source !== 'lifetime') {
        console.warn('Founding price refused for non-lifetime user', userId, priceId);
        return res.status(403).json({ error: 'founding_rate_lifetime_only' });
      }
    }

    // Let the price itself decide: recurring => subscription, otherwise => one-off payment (lifetime).
    const price = await stripe.prices.retrieve(priceId);
    const mode = price.recurring ? 'subscription' : 'payment';

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/?checkout=cancel`,
      // Rewardful referral ONLY. Must be OMITTED entirely when absent — a blank
      // client_reference_id makes Stripe throw and breaks all checkout. The buyer's
      // identity travels in metadata.supabase_user_id below, not here.
      ...(referral ? { client_reference_id: referral } : {}),
      customer_email: email || undefined,
      allow_promotion_codes: true,
      metadata: { supabase_user_id: userId || '' },
      ...(mode === 'subscription'
        ? { subscription_data: { metadata: { supabase_user_id: userId || '' } } }
        // customer_creation:'always' forces a Stripe Customer on the one-off
        // (Lifetime) path — in 'payment' mode Stripe can otherwise charge a guest
        // with no Customer, and Rewardful attributes referrals to a Customer, so
        // without this an affiliate's Lifetime sale earns silently nothing. Stripe
        // rejects this key in 'subscription' mode, so it lives only on this branch.
        : { customer_creation: 'always',
            payment_intent_data: { metadata: { supabase_user_id: userId || '' } } }),
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return res.status(500).json({ error: err.message });
  }
}
