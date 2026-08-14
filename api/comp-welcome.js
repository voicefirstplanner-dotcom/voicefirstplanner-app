// api/comp-welcome.js
// ---------------------------------------------------------------------------
// Comp accounts (14 Aug 2026). Single purpose: fire the LIFETIME WELCOME for an
// account that grant_comp() has just comped. It is called by the database, not
// by a person and never by the browser — grant_comp() posts here via pg_net with
// the shared secret, exactly the shape on_user_confirmed -> api/user-confirmed
// already uses in this codebase.
//
// ⛔ IT OWNS NO EMAIL DESIGN. It imports fireLifetimeWelcome from the webhook,
// which is the same function the paid path calls — same template, same tokenised
// links, same one-per-member idempotency claim. There is deliberately no second
// template here to drift when the original is edited.
//
// ⛔ IT GRANTS NOTHING. Entitlements are written by grant_comp() in the database.
// This endpoint only sends, and only for an account already marked comp=true —
// so even with the secret, it cannot be used to mint an entitlement.
import { createClient } from '@supabase/supabase-js';
import { fireLifetimeWelcome } from './stripe-webhook.js';

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Same dedicated secret the confirm hook uses. Without it this endpoint refuses
// to run at all — an unauthenticated send route is an email-bomb and a Resend
// reputation risk.
const HOOK_SECRET = process.env.CONFIRM_HOOK_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!HOOK_SECRET) {
    console.error('CONFIRM_HOOK_SECRET not set — refusing to run unauthenticated');
    return res.status(500).json({ error: 'server_misconfigured' });
  }
  const authz = req.headers['authorization'] || '';
  const bearer = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  const presented = bearer || req.headers['x-webhook-secret'] || '';
  if (presented !== HOOK_SECRET) {
    console.warn('comp-welcome: bad or missing secret — refused');
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const { user_id: userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'missing_user_id' });

    // The account must already be comped. This endpoint sends for comps only.
    const { data: ent } = await admin
      .from('entitlements')
      .select('comp')
      .eq('user_id', userId)
      .maybeSingle();
    if (ent?.comp !== true) {
      console.warn('comp-welcome: user', userId, 'is not comped — refused');
      return res.status(403).json({ error: 'not_comp' });
    }

    // Address and name come from the account itself, never from the request —
    // so a caller holding the secret still cannot redirect the email.
    const { data: userRes, error: uErr } = await admin.auth.admin.getUserById(userId);
    if (uErr || !userRes?.user?.email) {
      console.error('comp-welcome: no email for user', userId, uErr?.message);
      return res.status(404).json({ error: 'no_email_for_user' });
    }
    const email = userRes.user.email;
    const firstName = userRes.user.user_metadata?.first_name
      || userRes.user.user_metadata?.name
      || '';

    // The same sender the paid path uses. Its own idempotency claim means a
    // second grant sends nothing, with no extra guard needed here.
    await fireLifetimeWelcome(userId, email, firstName);
    console.log('comp-welcome: lifetime welcome fired for', userId);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('comp-welcome failed:', e.message);
    return res.status(500).json({ error: 'send_failed' });
  }
}
