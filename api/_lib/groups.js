// api/_lib/groups.js — 26 Nov 2026: Groups step 6, Stripe for Duo, Family and Team (Pricing v10.8 §2B; 8 Nov brief §6).
// Not a Vercel function (files in _lib aren't routed), so it doesn't count toward the Hobby plan's 12.
//
// How Stripe carries a group plan (the App Room's call, brief 26 Nov "Your calls"):
//   · ONE subscription per plan. Its lines: the plan itself (quantity 1), plus "one more person" (Family) or "five more
//     people" (Team) and "a Team member moved up to Pro", each as a quantity. Every price is found by its LOOKUP KEY, so
//     test mode and live mode need no different code:
//        vfp_group_<duo|family|team>_<year|month>        the plan                         (§2B.2)
//        vfp_group_<duo|family|team>_lifetime_year       the plan for a Lifetime member   (§2B.5, annual only)
//        vfp_group_family_extra_<year|month>             one more person on a Family      (§2B.4)
//        vfp_group_team_extra_<year|month>               five more people on a Team       (§2B.4)
//        vfp_group_team_pro_<year|month>                 a Team member moved up to Pro    (§2B.4)
//     Each price carries metadata vfp_group (duo|family|team) and vfp_line (base|extra|pro_move). The subscription carries
//     metadata vfp_group, which is how the webhook knows it's a group plan and never writes it as the payer's own plan.
//   · A Lifetime member's plan uses the lifetime_year price for the plan and the _year add-ons (§2B.5: same add-on prices).
//   · Switching over (§2B.9): a member paying for their own Premium or Pro (monthly, yearly, or a Lifetime member's Pro at
//     the founding rate) is switched over when they buy. What's left of what they paid comes off the first bill as a
//     one-time credit at checkout (a coupon for that amount, used once). Anything left beyond the first bill goes on their
//     Stripe credit balance, which comes off the bills after. When the plan is paid, their own subscription is stopped at
//     once with no proration (the credit has already been given). A credit, not a refund: VFP gives no refunds.
//   · Add-ons are added in the app: the subscription's quantity goes up by one, Stripe charges the time left at once
//     (always_invoice), and if the card is declined nothing changes (error_if_incomplete).
//   · A takeover (§2B.9; Dave 8 Nov, answers 2 and 3) is a new subscription for the plan as it stands (its extra people and
//     Pro moves), at full price; at the Lifetime price for a Lifetime member. The database decides who was first. A second
//     payer is refunded and their subscription stopped (the one exception to "no refunds").
//   · Hidden: the database says who may buy (vfp_plans_open_to: the tester list, or everyone once the switch says 'all').
export const GROUP_KINDS = ['duo', 'family', 'team'];
export const GROUP_BILLING = ['year', 'month'];
export const SWITCH_CREDIT_NAME = 'Credit for time already paid';   // shown on the checkout page and the receipt (new words)
const CHECKOUT_SECONDS = 3600;
const ADDON_MAX = 50;                                                // a sanity limit per line, not a rule

export function baseKey(kind, billing, lifetime) {
  return lifetime ? `vfp_group_${kind}_lifetime_year` : `vfp_group_${kind}_${billing}`;
}
export function addOnKey(kind, line, billing) {
  if (line === 'extra' && (kind === 'family' || kind === 'team')) return `vfp_group_${kind}_extra_${billing}`;
  if (line === 'pro_move' && kind === 'team') return `vfp_group_team_pro_${billing}`;
  return null;
}
// Prices by lookup key (Stripe answers up to 10 keys a call). Returns { key: price } for active, recurring prices only.
export async function pricesByKey(stripe, keys) {
  const out = {};
  const want = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < want.length; i += 10) {
    const list = await stripe.prices.list({ lookup_keys: want.slice(i, i + 10), active: true, limit: 10 });
    for (const p of (list && list.data) || []) if (p && p.lookup_key && p.recurring) out[p.lookup_key] = p;
  }
  return out;
}
export function isGroupSub(sub) { return !!(sub && sub.metadata && sub.metadata.vfp_group); }
// 26 Nov 2026 (walk faults WF2–WF4): a subscription that pays for a Duo, Family or Team is never a member's own plan,
// whatever their entitlements row says. The database knows every one the server has seen (6h: vfp_is_group_sub); Stripe's
// own mark (metadata vfp_group) is the second check. If the database can't be asked: treat it as a group plan, so
// nothing is switched over, credited or stopped.
export async function isGroupPlanSub({ stripe, supabase, subId }) {
  if (!subId) return false;
  const { data, error } = await supabase.rpc('vfp_is_group_sub', { p_sub: subId });
  if (error) { console.warn('vfp_is_group_sub:', error.message); return true; }
  if (data === true) return true;
  try { return isGroupSub(await stripe.subscriptions.retrieve(subId)); } catch (e) { return false; }
}
const lineOf = (it) => (it && it.price && it.price.metadata && it.price.metadata.vfp_line) || '';
// The plan's size from its subscription's lines.
export function sizeOf(sub) {
  const items = (sub && sub.items && Array.isArray(sub.items.data)) ? sub.items.data : [];
  let extra = 0, moves = 0;
  for (const it of items) {
    if (lineOf(it) === 'extra') extra += it.quantity || 0;
    if (lineOf(it) === 'pro_move') moves += it.quantity || 0;
  }
  return { extra, moves };
}
const idOf = (x) => (x && typeof x === 'object') ? x.id : (x || null);
const unix = (ms) => Math.floor((ms || Date.now()) / 1000);

// What's left of the member's own paid subscription, in cents, or 0. Reads only Stripe's record of what they paid:
// the latest PAID invoice of that subscription, times the share of its period still to come. No credit for a trial, a
// subscription that has ended, or an unpaid bill.
export async function switchCredit(stripe, subId, nowMs) {
  if (!subId) return { cents: 0, sub: null };
  let sub;
  try { sub = await stripe.subscriptions.retrieve(subId, { expand: ['latest_invoice'] }); }
  catch (e) { return { cents: 0, sub: null }; }
  if (!sub || !['active', 'past_due'].includes(sub.status)) return { cents: 0, sub: null };
  if (isGroupSub(sub)) return { cents: 0, sub: null };                     // WF4: a group plan is never switched over
  const inv = sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  const paid = inv && inv.status === 'paid' ? (inv.amount_paid || 0) : 0;
  const item = sub.items && sub.items.data && sub.items.data[0];
  const start = sub.current_period_start || (item && item.current_period_start);
  const end = sub.current_period_end || (item && item.current_period_end);
  const now = unix(nowMs);
  if (!paid || !start || !end || end <= now || end <= start) return { cents: 0, sub: sub.id };
  return { cents: Math.floor(paid * (end - now) / (end - start)), sub: sub.id };
}

// ── The checkout: POST { group: { kind, billing, takeover? }, referral? }, signed in. Every rule is checked here.
export async function groupCheckout({ stripe, supabase, me, body, referral, appUrl }) {
  const g = (body && body.group) || {};
  const billing = g.billing;
  let kind = g.kind;
  const takeover = typeof g.takeover === 'string' && /^[0-9a-f-]{36}$/i.test(g.takeover) ? g.takeover : null;
  if (!takeover && !GROUP_KINDS.includes(kind)) return [400, { error: 'Unknown plan' }];
  if (!GROUP_BILLING.includes(billing)) return [400, { error: 'Unknown plan' }];
  // hidden until the switch says 'all', except for the tester list (the database's answer; in doubt, closed)
  const { data: open, error: openErr } = await supabase.rpc('vfp_plans_open_to', { p_user: me.id });
  if (openErr || open !== true) return [403, { error: 'groups_not_open' }];
  const { data: ent, error: entErr } = await supabase.from('entitlements')
    .select('plan,source,status,comp,stripe_customer_id,stripe_subscription_id,bf_paid_to').eq('user_id', me.id).maybeSingle();
  if (entErr) { console.error('group checkout: entitlement read failed:', entErr.message); return [503, { error: 'Could not start checkout' }]; }
  const e = ent || {};
  // A member in their two paid Black Friday years: as the usual checkout (moving plan is Dave's ruling to make).
  if (e.bf_paid_to && Date.parse(e.bf_paid_to) > Date.now()) return [409, { error: "Your Black Friday plan is already paid for. Changing plan isn't open yet." }];
  const lifetime = e.source === 'lifetime';
  if (lifetime && billing !== 'year') return [400, { error: 'lifetime_annual_only' }];   // §2B.5: annual only at launch
  let extra = 0, moves = 0, until = null;
  if (takeover) {
    const { data: info, error: infoErr } = await supabase.rpc('vfp_plan_takeover_info', { p_user: me.id, p_plan: takeover });
    if (infoErr || !info) return [503, { error: 'Could not start checkout' }];
    if (!info.ok) return [409, { error: info.reason }];
    kind = info.kind; extra = info.extra || 0; moves = info.moves || 0; until = Date.parse(info.until);
  }
  const addBilling = lifetime ? 'year' : billing;
  const keys = [baseKey(kind, billing, lifetime), extra ? addOnKey(kind, 'extra', addBilling) : null, moves ? addOnKey(kind, 'pro_move', addBilling) : null];
  const prices = await pricesByKey(stripe, keys);
  if (keys.some(k => k && !prices[k])) { console.error('group checkout: price missing for', keys.filter(k => k && !prices[k])); return [503, { error: 'Could not start checkout' }]; }
  const lines = [{ price: prices[keys[0]].id, quantity: 1 }];
  if (extra) lines.push({ price: prices[keys[1]].id, quantity: extra });
  if (moves) lines.push({ price: prices[keys[2]].id, quantity: moves });
  const firstBill = (prices[keys[0]].unit_amount || 0) + (extra ? prices[keys[1]].unit_amount * extra : 0) + (moves ? prices[keys[2]].unit_amount * moves : 0);
  // the session can't outlive the takeover window
  const nowS = unix();
  let expiresAt = nowS + CHECKOUT_SECONDS;
  if (until) expiresAt = Math.min(expiresAt, Math.floor(until / 1000));
  if (expiresAt - nowS < 30 * 60) return [409, { error: 'takeover_closed' }];
  // switching over: their own paying plan (not a comp, not Lifetime Premium itself)
  let credit = { cents: 0, sub: null };
  const paying = e.stripe_subscription_id && e.comp !== true && ['premium', 'pro'].includes(e.plan) && ['active', 'trialing', 'past_due'].includes(e.status || '')
    && !(await isGroupPlanSub({ stripe, supabase, subId: e.stripe_subscription_id }));   // WF4: a Duo/Family/Team they pay for isn't their own plan
  if (paying) credit = await switchCredit(stripe, e.stripe_subscription_id);
  const couponCents = Math.min(credit.cents, firstBill);
  const rest = credit.cents - couponCents;
  let discounts = null;
  if (couponCents > 0) {
    const coupon = await stripe.coupons.create({
      amount_off: couponCents, currency: (prices[keys[0]].currency || 'usd'), duration: 'once', max_redemptions: 1,
      redeem_by: nowS + 2 * CHECKOUT_SECONDS, name: SWITCH_CREDIT_NAME,
      metadata: { supabase_user_id: me.id, vfp_switch_from: credit.sub || '' },
    });
    discounts = [{ coupon: coupon.id }];
  }
  const meta = { supabase_user_id: me.id, vfp_group: kind, vfp_billing: billing, vfp_lifetime: lifetime ? '1' : '0', vfp_takeover: takeover || '',
                 vfp_switch_from: (paying && credit.sub) ? credit.sub : (paying ? e.stripe_subscription_id : ''), vfp_credit_rest: String(rest > 0 ? rest : 0) };
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: lines,
    success_url: `${appUrl}/?checkout=success&bought=group_${kind}${takeover ? '&plan=' + takeover : ''}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/?checkout=cancel`,
    ...(referral ? { client_reference_id: referral } : {}),
    ...(e.stripe_customer_id ? { customer: e.stripe_customer_id } : { customer_email: me.email || undefined }),
    // TOOLFINDER50 stays on the usual checkout only, as today (brief 26 Nov). Whether group checkouts take it is Dave's.
    ...(discounts ? { discounts } : { allow_promotion_codes: false }),
    expires_at: expiresAt,
    metadata: meta,
    subscription_data: { metadata: { supabase_user_id: me.id, vfp_group: kind, vfp_billing: billing, vfp_lifetime: lifetime ? '1' : '0' } },
  });
  return [200, { url: session.url }];
}

// 26 Nov 2026 (WF2): switched over, their own subscription has just been stopped, so their row says so now, without
// waiting for Stripe's "deleted" event (which says the same). Only if the row still carries that subscription, and as the
// webhook's own rules: a comp row is never touched; a Lifetime member's founding-rate Pro falls back to Lifetime Premium.
async function endOwnPlan(supabase, userId, subId) {
  const { data: e, error } = await supabase.from('entitlements').select('plan,source,comp,stripe_subscription_id').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('entitlements read: ' + error.message);
  if (!e || e.comp === true || e.stripe_subscription_id !== subId) return;
  const row = e.source === 'lifetime'
    ? { plan: 'premium', source: 'lifetime', status: 'active', stripe_subscription_id: null, current_period_end: null }
    : { plan: 'free', status: 'canceled' };
  const { error: e2 } = await supabase.from('entitlements').update({ ...row, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('stripe_subscription_id', subId);
  if (e2) throw new Error('entitlements update: ' + e2.message);
}

// The member's entitlements row carries their Stripe customer (the billing page uses it). Never changes their plan.
async function ensureCustomer(supabase, userId, customerId) {
  if (!userId || !customerId) return;
  const { data, error } = await supabase.from('entitlements').select('stripe_customer_id').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('entitlements read: ' + error.message);
  if (!data) {
    const { error: e2 } = await supabase.from('entitlements').upsert({ user_id: userId, plan: 'free', status: 'inactive', stripe_customer_id: customerId, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (e2) throw new Error('entitlements insert: ' + e2.message);
  } else if (!data.stripe_customer_id) {
    const { error: e3 } = await supabase.from('entitlements').update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() }).eq('user_id', userId).is('stripe_customer_id', null);
    if (e3) throw new Error('entitlements update: ' + e3.message);
  }
}

// The subscription changed (or ended): the plan follows it.
export async function groupSync({ stripe, supabase, sub, status }) {
  let s = sub;
  try { s = await stripe.subscriptions.retrieve(sub.id); } catch (e) { console.warn('group sync: using the event payload:', e.message); }
  const { extra, moves } = sizeOf(s);
  const { data, error } = await supabase.rpc('vfp_plan_stripe_sync', { p_sub: s.id, p_status: status || s.status, p_extra: extra, p_moves: moves });
  if (error) throw new Error('vfp_plan_stripe_sync: ' + error.message);
  return data;
}

// A paid group checkout (the webhook). Safe to run twice: the database knows the subscription; Stripe calls carry keys.
export async function groupComplete({ stripe, supabase, session }) {
  const m = session.metadata || {};
  const userId = m.supabase_user_id;
  if (!userId || !GROUP_KINDS.includes(m.vfp_group) || !GROUP_BILLING.includes(m.vfp_billing)) return { done: false, why: 'bad metadata' };
  const subId = idOf(session.subscription);
  const sub = await stripe.subscriptions.retrieve(subId);
  const { extra, moves } = sizeOf(sub);
  const { data: r, error } = await supabase.rpc('vfp_plan_from_stripe', {
    p_user: userId, p_kind: m.vfp_group, p_sub: sub.id, p_customer: idOf(session.customer), p_billing: m.vfp_billing,
    p_lifetime: m.vfp_lifetime === '1', p_extra: extra, p_moves: moves, p_takeover: m.vfp_takeover || null,
    p_group_name: null, p_session: session.id,
  });
  if (error) throw new Error('vfp_plan_from_stripe: ' + error.message);
  if (r && r.ok) {
    await ensureCustomer(supabase, userId, idOf(session.customer));
    // switched over: their own plan stops now; the credit was given at checkout (and any rest goes on their balance)
    if (m.vfp_switch_from && !(await isGroupPlanSub({ stripe, supabase, subId: m.vfp_switch_from }))) {   // WF4: never a group plan
      try { await stripe.subscriptions.cancel(m.vfp_switch_from, { prorate: false, invoice_now: false }); }
      catch (e) { if (!/canceled|No such subscription|resource_missing/i.test(String(e && e.message))) throw e; }
      await endOwnPlan(supabase, userId, m.vfp_switch_from);               // WF2: their row shows their own plan ended
    }
    const rest = parseInt(m.vfp_credit_rest || '0', 10);
    if (rest > 0) {
      await stripe.customers.createBalanceTransaction(idOf(session.customer), { amount: -rest, currency: 'usd', description: SWITCH_CREDIT_NAME },
        { idempotencyKey: 'vfp-switch-credit-' + session.id });
    }
    await groupSync({ stripe, supabase, sub, status: sub.status });
    return { done: true, action: r.action, plan_id: r.plan_id };
  }
  const reason = r && r.reason;
  if (reason === 'already_refunded') return { done: false, why: reason };
  // Somebody else paid for this takeover first, or its 30 days ran out: this payment is refunded and its subscription
  // stopped (Pricing §2B.9, the one exception to "no refunds"). Their own plan is NOT switched over.
  try { await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false }); }
  catch (e) { if (!/canceled|No such subscription|resource_missing/i.test(String(e && e.message))) throw e; }
  const invId = idOf(session.invoice) || idOf(sub.latest_invoice);
  if (invId) {
    const inv = await stripe.invoices.retrieve(invId);
    const pi = idOf(inv.payment_intent);
    const charge = idOf(inv.charge);
    if ((pi || charge) && (inv.amount_paid || 0) > 0) {
      await stripe.refunds.create(pi ? { payment_intent: pi } : { charge }, { idempotencyKey: 'vfp-takeover-refund-' + sub.id });
    }
  }
  const { error: recErr } = await supabase.rpc('vfp_plan_refund_record', { p_user: userId, p_sub: sub.id, p_session: session.id,
    p_reason: reason === 'closed' ? 'closed' : 'taken', p_plan: (r && r.plan_id) || m.vfp_takeover || null });
  if (recErr) throw new Error('vfp_plan_refund_record: ' + recErr.message);
  return { done: false, why: reason, refunded: true };
}

// ── In the app: the owner adds one more person (Family), five more people (Team) or a Pro move (Team).
// POST /api/create-portal-session { action: 'group_add', plan_id, what: 'person' | 'five' | 'pro_move' }, signed in.
export async function groupAddOn({ stripe, supabase, me, body }) {
  const planId = body && body.plan_id, what = body && body.what;
  if (typeof planId !== 'string' || !/^[0-9a-f-]{36}$/i.test(planId)) return [400, { error: 'not_allowed' }];
  const { data: info, error } = await supabase.rpc('vfp_plan_billing', { p_user: me.id, p_plan: planId });
  if (error || !info) return [503, { error: 'Could not reach billing — please try again' }];
  if (!info.ok) return [info.reason === 'not_allowed' ? 403 : 409, { error: info.reason }];
  if (!info.open) return [403, { error: 'groups_not_open' }];
  const line = (what === 'person' && info.kind === 'family') || (what === 'five' && info.kind === 'team') ? 'extra'
    : (what === 'pro_move' && info.kind === 'team') ? 'pro_move' : null;
  if (!line) return [400, { error: 'not_allowed' }];
  const billing = info.lifetime ? 'year' : info.billing;
  const key = addOnKey(info.kind, line, billing);
  const prices = await pricesByKey(stripe, [key]);
  const price = prices[key];
  if (!price) return [503, { error: 'Could not reach billing — please try again' }];
  const sub = await stripe.subscriptions.retrieve(info.sub);
  const item = (sub.items && sub.items.data || []).find(it => it.price && (it.price.id === price.id || lineOf(it) === line));
  const now = item ? (item.quantity || 0) : 0;
  if (now >= ADDON_MAX) return [409, { error: 'too_many' }];
  let updated;
  try {
    updated = await stripe.subscriptions.update(sub.id, {
      items: item ? [{ id: item.id, quantity: now + 1 }] : [{ price: price.id, quantity: 1 }],
      proration_behavior: 'always_invoice',          // the time left is charged now
      payment_behavior: 'error_if_incomplete',       // a declined card changes nothing
    }, { idempotencyKey: `vfp-add-${planId}-${line}-${now + 1}` });
  } catch (e) {
    if (e && (e.type === 'StripeCardError' || e.code === 'card_declined' || /card|payment/i.test(String(e.message)))) return [402, { error: 'payment_failed' }];
    throw e;
  }
  const r = await groupSync({ stripe, supabase, sub: updated, status: updated.status });
  return [200, { ok: true, size: r && r.size }];
}

// ── After joining someone's Duo, Family or Team (Pricing §2B.9): a member paying for their own Premium lets it run to
// the end of what they've paid, then it doesn't renew; a member paying for their own Pro chooses (stop_own). Only the
// signed-in member's own subscription, and only once the database says they hold a paid seat on someone else's plan.
// Lifetime, comp and Black Friday plans are never touched.
// POST /api/create-portal-session { action: 'group_joined', stop_own: true|false }, signed in.
export async function groupJoined({ stripe, supabase, me, body }) {
  const { data: holds, error } = await supabase.rpc('vfp_seat_holder', { p_user: me.id });
  if (error || holds !== true) return [200, { stopped: false }];
  const { data: e } = await supabase.from('entitlements')
    .select('plan,source,status,comp,stripe_subscription_id,bf_paid_to').eq('user_id', me.id).maybeSingle();
  if (!e || e.comp === true || e.source === 'lifetime' || !e.stripe_subscription_id) return [200, { stopped: false }];
  if (e.bf_paid_to && Date.parse(e.bf_paid_to) > Date.now()) return [200, { stopped: false }];
  if (!['active', 'trialing', 'past_due'].includes(e.status || '')) return [200, { stopped: false }];
  if (await isGroupPlanSub({ stripe, supabase, subId: e.stripe_subscription_id })) return [200, { stopped: false }];   // WF3: never a plan they pay for
  const stop = e.plan === 'premium' || (e.plan === 'pro' && body && body.stop_own === true);
  if (!stop) return [200, { stopped: false }];
  const sub = await stripe.subscriptions.update(e.stripe_subscription_id, { cancel_at_period_end: true });
  const end = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || null;
  return [200, { stopped: true, until: end ? new Date(end * 1000).toISOString() : null }];
}
