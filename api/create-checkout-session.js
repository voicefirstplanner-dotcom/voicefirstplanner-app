import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'https://app.voicefirstdayplanner.com';

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
