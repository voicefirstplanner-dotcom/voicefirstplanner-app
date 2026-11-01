// api/_lib/sub-lines.js — 31 Oct 2026 (Groups, step 0).
// A Stripe subscription is a list of lines (items). Until now the webhook read
// only the first line. The Family, Duo and Team plans will have several (the
// plan, extra seats, members moved up to Pro), so the webhook reads them all:
// the line that decides the member's plan is the one carrying the highest plan
// (pro above premium), and the period end is the latest across every line.
// A subscription with one line, which is every subscription today, gives
// exactly the answer the first-line reading gave.
const RANK = { pro: 2, premium: 1 };

export function mainLine(sub, planOf) {
  const items = (sub && sub.items && Array.isArray(sub.items.data)) ? sub.items.data : [];
  if (!items.length) return null;
  let best = items[0], bestRank = -1;
  for (const it of items) {
    const r = RANK[planOf(it && it.price)] ?? 0;
    if (r > bestRank) { best = it; bestRank = r; }
  }
  return best;
}

export function latestPeriodEnd(sub) {
  if (sub && sub.current_period_end) return sub.current_period_end;
  const items = (sub && sub.items && Array.isArray(sub.items.data)) ? sub.items.data : [];
  let ts = null;
  for (const it of items) if (it && it.current_period_end && (!ts || it.current_period_end > ts)) ts = it.current_period_end;
  return ts;
}
