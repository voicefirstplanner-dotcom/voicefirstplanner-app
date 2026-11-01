// api/_lib/plan.js — 31 Oct 2026 (Groups, step 0).
// The ONE way the server asks what plan a member has. It asks the database
// function vfp_effective_plan, which today returns exactly the plan on the
// member's entitlements row ('free' when there is none). Groups will widen that
// function in the database, and every server check follows without a code change.
// If the function is missing or the call fails, it falls back to reading the
// entitlements row exactly as the server did before, so no member is ever
// gated by this change. Never routed: Vercel's Hobby plan allows 12 functions.
export async function effectivePlan(supabase, userId) {
  if (!supabase || !userId) return 'free';
  try {
    const { data, error } = await supabase.rpc('vfp_effective_plan', { p_user_id: userId });
    if (!error && typeof data === 'string' && data) return data;
    if (error) console.warn('vfp_effective_plan unavailable; reading entitlements:', error.message);
  } catch (e) {
    console.warn('vfp_effective_plan threw; reading entitlements:', e && e.message);
  }
  const { data: ent } = await supabase
    .from('entitlements')
    .select('plan')
    .eq('user_id', userId)
    .maybeSingle();
  return (ent && ent.plan) || 'free';
}
