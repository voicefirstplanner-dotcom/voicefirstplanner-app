// api/_lib/black-friday.js — 14 Nov 2026: Black Friday, 2 years for the price of 1 (Pricing v10.8 §1B).
// Not a Vercel function (files in _lib aren't routed), so it doesn't count toward the Hobby plan's 12.
//
// How it works (fault F4, 14 Nov 20:40: nothing a member reads may say "every 2 years"; no "trial"):
//   · ONE payment at Checkout (payment mode), on a one-off Black Friday price, with the card saved for later:
//       Pro $89 · Premium $47.88 · founding-rate Pro $22.25 (Lifetime members).
//     Each price carries metadata: vfp_bf = 'pro' | 'premium' | 'lifetime', then_price = the usual yearly price id
//     from the third year, plan = 'pro' on the two Pro prices, checkout_line = the Pricing v10.8 §1B line.
//     Found by lookup key, so test mode and live mode need no different code or settings.
//   · After payment, the webhook (bfGrant):
//       1. marks the member paid for two years (entitlements: the plan, bf_paid_to, bf_route);
//       2. makes a subscription schedule that STARTS the usual yearly subscription two years from the payment, on the
//          saved card. Until then there is no subscription, so nothing to see or cancel but the one paid invoice;
//       3. (the webhook) sends the usual welcome.
//   · Year 3: the schedule starts an ordinary yearly subscription; the webhook then lets the schedule go (bfReleaseIfStarted)
//     and clears bf_paid_to. From then on it's like any yearly member.
//   · Settings › Stop renewal cancels the future start (bfStopRenewal); Keep renewing makes it again (bfKeepRenewing).
//     A stopped grant ends at bf_paid_to by the daily database job vfp_bf_expire() (SQL BF13).
//   · One setting in the database (vfp_bf_settings, read through vfp_bf_status) says whether it's open, and when it ends.
export const BF_LOOKUP = {
  pro: 'vfp_bf_pro_once',
  premium: 'vfp_bf_premium_once',
  lifetime: 'vfp_bf_founding_pro_once',
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

// The Black Friday price for a route, found by its lookup key; null if Stripe has none, or it isn't a one-off price.
export async function bfPrice(stripe, route) {
  const key = BF_LOOKUP[route];
  if (!key) return null;
  const list = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const p = list && list.data && list.data[0];
  return p && !p.recurring && p.metadata && p.metadata.vfp_bf === route && p.metadata.then_price ? p : null;
}

export function isBfPrice(price) {
  return !!(price && price.metadata && price.metadata.vfp_bf);
}

// Who may buy which route (Pricing v10.8 §1B). Reads only the member's OWN entitlements row.
//   'ok' | 'lifetime_use_founding' | 'already_paying' | 'lifetime_only'
export function bfWho(route, ent) {
  const e = ent || {};
  const lifetime = e.source === 'lifetime';
  const paidBf = e.bf_paid_to && Date.parse(e.bf_paid_to) > Date.now();
  if (route === 'lifetime') {
    if (!lifetime) return 'lifetime_only';
    if (e.plan === 'pro' || paidBf) return 'already_paying';      // a Lifetime member already paying for Pro is out
    return 'ok';
  }
  if (lifetime) return 'lifetime_use_founding';                   // pointed to the Lifetime route, never sold Pro at $89
  if (e.comp === true) return 'already_paying';                   // a comp account already holds a paid plan
  const paid = e.plan === 'premium' || e.plan === 'pro';
  const live = ['active', 'trialing', 'past_due', 'incomplete'].includes(e.status || '');
  if (paid || paidBf || (e.stripe_subscription_id && live)) return 'already_paying';
  return 'ok';
}

// Black Friday checkouts close an hour after they open, or at the cut-off if that's sooner (Dave, 14 Nov, Q1 (a)).
// Stripe needs at least 30 minutes.
export const BF_CHECKOUT_SECONDS = 3600;
export function bfExpiresAt(status, nowMs) {
  const cut = Date.parse(status && status.ends_at);
  const now = nowMs || Date.now();
  if (!Number.isFinite(cut)) return null;
  const max = Math.floor(now / 1000) + BF_CHECKOUT_SECONDS;
  const at = Math.min(Math.floor(cut / 1000), max);
  return at - Math.floor(now / 1000) >= 30 * 60 ? at : null;
}

// Two calendar years after a moment (seconds), same day and time, in UTC (29 Feb lands on 1 Mar).
export function bfPlusTwoYears(sec) {
  const d = new Date(sec * 1000);
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  return Math.floor(d.getTime() / 1000);
}

function idOf(x) { return x ? (typeof x === 'string' ? x : x.id) : null; }

// The Black Friday schedule for a customer that hasn't started yet (the future yearly subscription), or null.
export async function bfFutureSchedule(stripe, customerId) {
  if (!customerId) return null;
  const list = await stripe.subscriptionSchedules.list({ customer: customerId, limit: 100 });
  return (list.data || []).find(s => s.metadata && s.metadata.vfp_bf === 'set' && s.status === 'not_started') || null;
}

// The future yearly subscription: starts at paid_to, on the usual yearly price, charged to the saved card.
// After its first year it lets go and renews yearly as usual (the webhook lets it go earlier, as soon as it starts).
async function bfMakeFuture(stripe, { customerId, startSec, thenPrice, paymentMethod, userId, route, sessionId }) {
  return stripe.subscriptionSchedules.create({
    customer: customerId,
    start_date: startSec,
    end_behavior: 'release',
    default_settings: {
      collection_method: 'charge_automatically',
      ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
    },
    phases: [{
      items: [{ price: thenPrice, quantity: 1 }],
      iterations: 1,
      proration_behavior: 'none',
      metadata: { supabase_user_id: userId, vfp_bf_route: route },
    }],
    metadata: { vfp_bf: 'set', vfp_bf_route: route, supabase_user_id: userId, ...(sessionId ? { vfp_bf_session: sessionId } : {}) },
  });
}

// The webhook's step after a Black Friday payment (checkout.session.completed, payment mode, metadata.vfp_bf).
// Safe to run twice: the grant is the same, and the schedule is made only once per checkout session.
//   writeGrant(row) must THROW if the database write fails, so Stripe retries the event.
export async function bfGrant(stripe, session, { getEntitlement, writeGrant }) {
  const route = session.metadata && session.metadata.vfp_bf;
  const userId = session.metadata && session.metadata.supabase_user_id;
  if (!route || !BF_ROUTES.includes(route) || !userId) return { done: false, reason: 'not_black_friday' };
  if (session.payment_status !== 'paid') return { done: false, reason: 'not_paid' };
  const pi = await stripe.paymentIntents.retrieve(idOf(session.payment_intent));
  const customerId = idOf(session.customer) || idOf(pi.customer);
  if (!customerId) throw new Error('Black Friday session ' + session.id + ' has no customer');
  const lines = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
  const price = lines && lines.data && lines.data[0] && lines.data[0].price;
  if (!isBfPrice(price) || price.metadata.vfp_bf !== route || !price.metadata.then_price) {
    throw new Error('Black Friday session ' + session.id + ' has no matching Black Friday price');
  }
  const paidSec = pi.created || session.created;
  const paidTo = bfPlusTwoYears(paidSec);
  const paymentMethod = idOf(pi.payment_method);

  // 1. Paid for two years. Lifetime members keep source 'lifetime' (they fall back to Lifetime Premium, never free);
  //    everyone else is 'annual', so the Library gives them what an annual member of that plan gets.
  const held = (await getEntitlement(userId)) || {};
  await writeGrant({
    user_id: userId,
    plan: price.metadata.plan === 'pro' ? 'pro' : 'premium',
    source: held.source === 'lifetime' ? 'lifetime' : 'annual',
    status: 'active',
    stripe_customer_id: customerId,
    current_period_end: new Date(paidTo * 1000).toISOString(),
    bf_paid_to: new Date(paidTo * 1000).toISOString(),
    bf_route: route,
  });

  // 2. The card goes on the customer, so the yearly charge from year 3 can use it.
  if (paymentMethod) {
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethod } });
  }

  // 3. The future yearly subscription, once per checkout.
  const list = await stripe.subscriptionSchedules.list({ customer: customerId, limit: 100 });
  const mine = (list.data || []).find(s => s.metadata && s.metadata.vfp_bf_session === session.id);
  if (mine) return { done: true, already: true, schedule: mine.id, paid_to: paidTo };
  const sched = await bfMakeFuture(stripe, { customerId, startSec: paidTo, thenPrice: price.metadata.then_price, paymentMethod, userId, route, sessionId: session.id });
  return { done: true, schedule: sched.id, paid_to: paidTo };
}

// For Settings: a Black Friday member's paid-to date, and whether the yearly subscription will start then.
//   ent: { bf_paid_to, bf_route, stripe_customer_id }
export async function bfSubState(stripe, ent) {
  const e = ent || {};
  if (!e.bf_paid_to || !e.bf_route || Date.parse(e.bf_paid_to) <= Date.now()) return { bf: false };
  const future = await bfFutureSchedule(stripe, e.stripe_customer_id);
  let thenPrice = null;
  if (future) {
    const it = future.phases && future.phases[0] && future.phases[0].items && future.phases[0].items[0];
    thenPrice = it ? idOf(it.price) : null;
  }
  return { bf: true, route: e.bf_route, paid_to: new Date(Date.parse(e.bf_paid_to)).toISOString(), stopping: !future, then_price: thenPrice, schedule: future ? future.id : null };
}

export async function bfStopRenewal(stripe, state) {
  if (!state.schedule) return;                              // already stopped
  await stripe.subscriptionSchedules.cancel(state.schedule);
}

export async function bfKeepRenewing(stripe, state, { customerId, userId }) {
  if (state.schedule) return;                               // already renewing
  const price = await bfPrice(stripe, state.route);         // the route's then_price
  const thenPrice = price && price.metadata.then_price;
  if (!thenPrice) throw new Error('No Black Friday price for route ' + state.route);
  const cus = await stripe.customers.retrieve(customerId);
  const paymentMethod = cus && cus.invoice_settings ? idOf(cus.invoice_settings.default_payment_method) : null;
  await bfMakeFuture(stripe, { customerId, startSec: Math.floor(Date.parse(state.paid_to) / 1000), thenPrice, paymentMethod, userId, route: state.route, sessionId: null });
}

// Year 3: once the schedule has started the yearly subscription, let the schedule go, so it's an ordinary yearly
// subscription (renewals and Stripe's billing page as for any member). Called by the webhook on
// customer.subscription.created/updated. Returns the user id to clear bf_paid_to for.
export async function bfReleaseIfStarted(stripe, sub) {
  const schedId = sub ? idOf(sub.schedule) : null;
  if (!schedId) return { released: false };
  const sched = await stripe.subscriptionSchedules.retrieve(schedId);
  if (!sched.metadata || sched.metadata.vfp_bf !== 'set' || sched.status !== 'active') return { released: false };
  await stripe.subscriptionSchedules.release(schedId);
  return { released: true, schedule: schedId, user_id: sched.metadata.supabase_user_id || null };
}

// A refunded Black Friday payment (charge.refunded, the payment's metadata.vfp_bf): the future start is cancelled.
// (The grant itself is put back by the webhook, the same way the daily job would.)
export async function bfCancelFuture(stripe, customerId) {
  const future = await bfFutureSchedule(stripe, customerId);
  if (future) await stripe.subscriptionSchedules.cancel(future.id);
  return { cancelled: !!future };
}
