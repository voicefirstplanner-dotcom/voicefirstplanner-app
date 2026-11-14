// api/_lib/black-friday.js — 14 Nov 2026: Black Friday, 2 years for the price of 1 (Pricing v10.8 §1B).
// Not a Vercel function (files in _lib aren't routed), so it doesn't count toward the Hobby plan's 12.
//
// How it works in Stripe (the App Room's call, brief v2 §2):
//   · Three Black Friday prices, each on its own product, each charging once for TWO years:
//       Pro $89 every 2 years · Premium $47.88 every 2 years · founding-rate Pro $22.25 every 2 years.
//     Each carries metadata: vfp_bf = 'pro' | 'premium' | 'lifetime', then_price = the usual yearly price id that
//     takes over from the third year, and plan = 'pro' on the two Pro prices (the webhook keys the plan off it).
//     They're found by lookup key, so test mode and live mode need no different code or settings.
//   · After payment, the webhook puts the subscription on a schedule: phase 1 is the two-year price until the
//     paid two years end; phase 2 is the usual yearly price for one year; then the schedule lets go and it renews
//     yearly on that price. (iterations, not duration: this repo's Stripe library pins API version 2024-06-20.)
//   · One setting in the database (vfp_bf_settings, read through vfp_bf_status) says whether it's open, and when it ends.
export const BF_LOOKUP = {
  pro: 'vfp_bf_pro_2y',
  premium: 'vfp_bf_premium_2y',
  lifetime: 'vfp_bf_founding_pro_2y',
};
export const BF_ROUTES = Object.keys(BF_LOOKUP);

// The database's answer, or a closed answer if it can't be read: when in doubt, the offer is off.
export async function bfStatus(supabase) {
  try {
    const { data, error } = await supabase.rpc('vfp_bf_status');
    if (!error && data && typeof data === 'object') return { ...data, open: data.open === true };
    if (error) console.warn('vfp_bf_status failed:', error.message);
  } catch (e) {
    console.warn('vfp_bf_status threw:', e && e.message);
  }
  return { open: false, switched_on: false, ends_at: null, last_checkout_at: null, unreadable: true };
}

// The Black Friday price for a route, found by its lookup key; null if Stripe has none (not set up yet).
export async function bfPrice(stripe, route) {
  const key = BF_LOOKUP[route];
  if (!key) return null;
  const list = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const p = list && list.data && list.data[0];
  return p && p.metadata && p.metadata.vfp_bf === route ? p : null;
}

export function isBfPrice(price) {
  return !!(price && price.metadata && price.metadata.vfp_bf);
}

// Who may buy which route (Pricing v10.8 §1B). Reads only the member's OWN entitlements row.
//   'ok' | 'lifetime_use_founding' | 'already_paying' | 'lifetime_only'
export function bfWho(route, ent) {
  const e = ent || {};
  const lifetime = e.source === 'lifetime';
  if (route === 'lifetime') {
    if (!lifetime) return 'lifetime_only';
    if (e.plan === 'pro') return 'already_paying';          // a Lifetime member already paying for Pro is out
    return 'ok';
  }
  if (lifetime) return 'lifetime_use_founding';               // pointed to the Lifetime route, never sold Pro at $89
  if (e.comp === true) return 'already_paying';               // a comp account already holds a paid plan
  const paid = e.plan === 'premium' || e.plan === 'pro';
  const live = ['active', 'trialing', 'past_due', 'incomplete'].includes(e.status || '');
  if (paid || (e.stripe_subscription_id && live)) return 'already_paying';
  return 'ok';
}

// When the checkout must close: at the cut-off, and never later than Stripe's 24 hours.
export function bfExpiresAt(status, nowMs) {
  const cut = Date.parse(status && status.ends_at);
  const now = nowMs || Date.now();
  if (!Number.isFinite(cut)) return null;
  const max = Math.floor(now / 1000) + 24 * 3600 - 60;
  const at = Math.min(Math.floor(cut / 1000), max);
  return at - Math.floor(now / 1000) >= 30 * 60 ? at : null;   // Stripe needs at least 30 minutes
}

// The webhook's step after a Black Friday payment: put the subscription on its two-phase schedule. Safe to run twice.
export async function bfSchedule(stripe, subscriptionId) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  if (!isBfPrice(price)) return { done: false, reason: 'not_black_friday' };
  const then = price.metadata.then_price;
  if (!then) throw new Error('Black Friday price ' + price.id + ' has no then_price');
  let schedId = sub.schedule ? (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id) : null;
  if (!schedId) schedId = (await stripe.subscriptionSchedules.create({ from_subscription: sub.id })).id;
  const sched = await stripe.subscriptionSchedules.retrieve(schedId);
  if (sched.metadata && sched.metadata.vfp_bf === 'set') return { done: true, schedule: schedId, already: true };
  const p0 = sched.phases[0];
  await stripe.subscriptionSchedules.update(schedId, {
    end_behavior: 'release',
    proration_behavior: 'none',
    metadata: { vfp_bf: 'set', vfp_bf_route: price.metadata.vfp_bf },
    phases: [
      { items: [{ price: price.id, quantity: 1 }], start_date: p0.start_date, end_date: p0.end_date, proration_behavior: 'none' },
      { items: [{ price: then, quantity: 1 }], iterations: 1, proration_behavior: 'none' },
    ],
  });
  return { done: true, schedule: schedId };
}

// For Settings: a Black Friday subscription's state, and stopping or restarting its renewal.
export async function bfSubState(stripe, subscriptionId) {
  if (!subscriptionId) return { bf: false };
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const schedId = sub.schedule ? (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id) : null;
  if (!schedId) return { bf: false };
  const sched = await stripe.subscriptionSchedules.retrieve(schedId);
  if (!sched.metadata || sched.metadata.vfp_bf !== 'set' || ['released', 'canceled', 'completed'].includes(sched.status)) return { bf: false };
  const p0 = sched.phases[0];
  const thenItem = sched.phases[1] && sched.phases[1].items && sched.phases[1].items[0];
  return {
    bf: true,
    route: sched.metadata.vfp_bf_route || null,
    paid_to: new Date(p0.end_date * 1000).toISOString(),
    stopping: sched.end_behavior === 'cancel' || sched.phases.length < 2,
    then_price: thenItem ? (typeof thenItem.price === 'string' ? thenItem.price : thenItem.price.id) : null,
    schedule: schedId,
    _phase0: p0,
  };
}

export async function bfStopRenewal(stripe, state) {
  const p0 = state._phase0;
  const priceId = p0.items[0].price && (typeof p0.items[0].price === 'string' ? p0.items[0].price : p0.items[0].price.id);
  await stripe.subscriptionSchedules.update(state.schedule, {
    end_behavior: 'cancel',
    proration_behavior: 'none',
    phases: [{ items: [{ price: priceId, quantity: 1 }], start_date: p0.start_date, end_date: p0.end_date, proration_behavior: 'none' }],
  });
}

export async function bfKeepRenewing(stripe, state, thenPrice) {
  const p0 = state._phase0;
  const priceId = p0.items[0].price && (typeof p0.items[0].price === 'string' ? p0.items[0].price : p0.items[0].price.id);
  await stripe.subscriptionSchedules.update(state.schedule, {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: [
      { items: [{ price: priceId, quantity: 1 }], start_date: p0.start_date, end_date: p0.end_date, proration_behavior: 'none' },
      { items: [{ price: thenPrice, quantity: 1 }], iterations: 1, proration_behavior: 'none' },
    ],
  });
}
