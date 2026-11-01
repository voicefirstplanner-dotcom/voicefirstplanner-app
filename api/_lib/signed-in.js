// api/_lib/signed-in.js — 31 Oct 2026 (Groups, step 0).
// Who is calling? The answer comes ONLY from the sign-in token the app sends
// (Authorization: Bearer <access token>), checked with Supabase. An account id
// in the request body is never trusted: before this, the billing page and
// checkout took the id from the body, so anyone who knew another member's id
// could open that member's billing page. Returns { id, email } or null.
export async function signedInUser(req, supabase) {
  try {
    const auth = (req && req.headers && req.headers.authorization) || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || !supabase) return null;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user || !data.user.id) return null;
    return { id: data.user.id, email: data.user.email || '' };
  } catch (e) {
    return null;
  }
}
