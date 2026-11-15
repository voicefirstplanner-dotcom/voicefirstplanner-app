import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { signedInUser } from './_lib/signed-in.js';   // 31 Oct 2026: Groups step 0
import { bfStatus, bfPrice, bfWho, bfExpiresAt, isBfPrice, BF_ROUTES } from './_lib/black-friday.js';   // 14 Nov 2026

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

// POST { priceId, referral? }, signed in (Authorization: Bearer <access token>).
// Returns { url } — redirect the browser to it.
// 31 Oct 2026 (Groups step 0): the buyer is the SIGNED-IN account and its own
// email. A userId or email in the body is ignored. Before this, the founding-
// price check and the purchase's account were whatever id the browser sent.
// 14 Nov 2026 · Black Friday status for the website and the app: GET /api/black-friday (vercel.json sends it here,
// so no new function counts toward the Hobby plan's 12). Public, no sign-in, nothing private in it.
async function blackFridayStatus(req, res) {
  const st = await bfStatus(supabase);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({ open: st.open, ends_at: st.ends_at || null, last_checkout_at: st.last_checkout_at || null });
}

// 14 Nov 2026 · Black Friday checkout: POST { bf: 'pro' | 'premium' | 'lifetime', referral? }, signed in.
// Every rule is checked here, not in the app (Pricing v10.8 §1B, brief v2 §5).
async function blackFridayCheckout(req, res, me, route, referral) {
  const st = await bfStatus(supabase);
  if (!st.open) return res.status(410).json({ error: 'bf_ended' });
  const { data: ent, error: entErr } = await supabase
    .from('entitlements')
    .select('plan,source,status,comp,stripe_subscription_id,bf_paid_to')
    .eq('user_id', me.id)
    .maybeSingle();
  if (entErr) { console.error('Black Friday entitlement read failed:', entErr.message); return res.status(503).json({ error: 'Could not start checkout' }); }
  const who = bfWho(route, ent);
  if (who !== 'ok') return res.status(route === 'lifetime' && who === 'lifetime_only' ? 403 : 409).json({ error: 'bf_' + who });
  const price = await bfPrice(stripe, route);
  if (!price) return res.status(410).json({ error: 'bf_ended' });
  const expiresAt = bfExpiresAt(st);
  if (!expiresAt) return res.status(410).json({ error: 'bf_ended' });
  // TEST MODE ONLY: Stripe's test clocks, so the test run can move time past one and two years. Does nothing unless the
  // key is a test key AND VFP_BF_TEST_CLOCK is '1' (set on the black-friday-test preview only). Live never has either.
  let buyer = { customer_email: me.email || undefined };
  if (process.env.VFP_BF_TEST_CLOCK === '1' && String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')) {
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: ('BF ' + route + ' ' + (me.email || me.id)).slice(0, 300) });
    const cus = await stripe.customers.create({ email: me.email || undefined, test_clock: clock.id, metadata: { supabase_user_id: me.id } });
    buyer = { customer: cus.id };
  }
  // Fault F4 (14 Nov 20:40): ONE payment, no subscription at Checkout, so nothing says "every 2 years". The card is
  // saved for the yearly charge from the third year; the webhook sets that up (bfGrant).
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${APP_URL}/?checkout=success&bought=${route === 'premium' ? 'premium' : 'pro'}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/?checkout=cancel`,
    ...(referral ? { client_reference_id: referral } : {}),
    ...buyer,
    // No promotion code field at this checkout, so TOOLFINDER50 can't go on top (brief v2 §5.1).
    allow_promotion_codes: false,
    expires_at: expiresAt,   // it can't stay open past the cut-off
    ...(price.metadata && price.metadata.checkout_line ? { custom_text: { submit: { message: price.metadata.checkout_line } } } : {}),
    ...(buyer.customer ? {} : { customer_creation: 'always' }),
    payment_intent_data: {
      setup_future_usage: 'off_session',
      // vfp_bf marks it as Black Friday, so the refund handler never mistakes it for a Lifetime purchase.
      metadata: { supabase_user_id: me.id, vfp_bf: route },
    },
    invoice_creation: { enabled: true, invoice_data: { metadata: { vfp_bf: route } } },   // one paid invoice and receipt
    metadata: { supabase_user_id: me.id, vfp_bf: route },
  });
  return res.status(200).json({ url: session.url });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return blackFridayStatus(req, res);   // 14 Nov 2026: the only GET this function answers
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { priceId, referral, bf } = req.body || {};
    if (bf !== undefined) {
      if (!BF_ROUTES.includes(bf)) return res.status(400).json({ error: 'Unknown offer' });
      const meBf = await signedInUser(req, supabase);
      if (!meBf) return res.status(401).json({ error: 'Create an account or sign in to upgrade' });
      return await blackFridayCheckout(req, res, meBf, bf, referral);
    }
    if (!priceId) return res.status(400).json({ error: 'Missing priceId' });
    const me = await signedInUser(req, supabase);
    if (!me) return res.status(401).json({ error: 'Create an account or sign in to upgrade' });
    const userId = me.id, email = me.email;

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

    // 14 Nov 2026 (Black Friday, F4): a member in their two paid Black Friday years has their year-3 subscription
    // already set up; a second checkout would charge twice. Moving plan is Dave's ruling to make (brief v2 §5.8).
    {
      const { data: bfEnt, error: bfErr } = await supabase.from('entitlements').select('bf_paid_to').eq('user_id', userId).maybeSingle();
      if (!bfErr && bfEnt && bfEnt.bf_paid_to && Date.parse(bfEnt.bf_paid_to) > Date.now()) {
        return res.status(409).json({ error: "Your Black Friday plan is already paid for. Changing plan isn't open yet." });
      }
    }

    // Let the price itself decide: recurring => subscription, otherwise => one-off payment (lifetime).
    const price = await stripe.prices.retrieve(priceId);
    // 14 Nov 2026: a Black Friday price is sold only through its own route above, with its own checks.
    if (isBfPrice(price)) return res.status(400).json({ error: 'Missing priceId' });
    const mode = price.recurring ? 'subscription' : 'payment';
    // 14 Nov 2026 (Management Q2 (a)): the success address says which plan was bought, so the app's message names it.
    const bought = !price.recurring ? 'lifetime' : (price.metadata && price.metadata.plan === 'pro' ? 'pro' : 'premium');

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/?checkout=success&bought=${bought}&session_id={CHECKOUT_SESSION_ID}`,
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
