// api/ai-goal.js
// Pro Phase 2 — AI goal setting (4 Aug). Receives what the person says matters
// to them (typed, or transcribed by /api/transcribe) plus their existing life
// roles and values, and returns a PROPOSAL of long-term goals in the app's
// exact goal shape.
//
//   Request  (POST, JSON):  { text, today: "YYYY-MM-DD", roles: [names], values: [names] }
//            Header:        Authorization: Bearer <supabase access token>  (REQUIRED)
//   Response (JSON):        { goals: [ { name, tot, role, why } ] }
//
// ⛔ THE TRUST BOUNDARY, SERVER SIDE — identical to /api/ai-structure: this
// endpoint NEVER writes to anyone's planner. It returns a proposal and nothing
// else. Committing approved goals happens in the client, behind the review
// sheet's explicit "Add to planner" — there is no server path around that.
//
// Shape (must match addGoal() exactly; ids/cur assigned client-side at commit):
//   goal { name, tot: integer >= 1 (the measurable target / milestone count),
//          role: one of the CALLER'S role names or '', why: one-line rationale
//          shown on the review sheet, never committed to state }
//
// Security model, rate limits (transcribe_usage kind='ai' — shared AI ceiling),
// Pro gate, AI_TEST_USER_IDS: all cloned verbatim from /api/ai-structure.

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// ---- Model. One line, so a future swap stays a one-line change. ----
const MODEL = 'gpt-4o-mini';

// ---- Ceilings — the same shared 'ai' bucket as ai-structure ----
const USER_PER_HOUR = 30;
const USER_PER_DAY  = 100;

// ---- Proposal caps — the validator's hard ceilings, whatever the model says ----
const MAX_GOALS = 5;
const MAX_TEXT  = 200;      // chars per goal name
const MAX_WHY   = 300;      // chars per rationale line
const MAX_INPUT = 4000;     // chars of input accepted
const MAX_TOT   = 9999;     // target ceiling

const admin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// ---- Caller identity (strict: this endpoint has no anonymous mode) ----------
async function identify(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !admin) return null;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    return data.user.id;
  } catch (e) {
    return null;
  }
}

// ---- Pro gate ---------------------------------------------------------------
async function isPro(userId) {
  const testIds = (process.env.AI_TEST_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (testIds.includes(userId)) return true;
  if (!admin) return false;
  const { data: ent } = await admin
    .from('entitlements')
    .select('plan')
    .eq('user_id', userId)
    .maybeSingle();
  return ent?.plan === 'pro';
}

// ---- Rate limit (transcribe_usage, kind='ai' — fails OPEN like transcribe) --
async function checkAndRecord(actor) {
  if (!admin) return { allowed: true, degraded: true };
  const now = Date.now();
  const hourAgo = new Date(now - 3600e3).toISOString();
  const dayAgo  = new Date(now - 86400e3).toISOString();
  try {
    const { count: hourCount, error: e1 } = await admin
      .from('transcribe_usage')
      .select('id', { count: 'exact', head: true })
      .eq('actor', actor).eq('kind', 'ai')
      .gte('created_at', hourAgo);
    if (e1) throw e1;
    if ((hourCount || 0) >= USER_PER_HOUR) {
      return { allowed: false, used: hourCount, limit: USER_PER_HOUR, window: 'hour' };
    }
    const { count: dayCount, error: e2 } = await admin
      .from('transcribe_usage')
      .select('id', { count: 'exact', head: true })
      .eq('actor', actor).eq('kind', 'ai')
      .gte('created_at', dayAgo);
    if (e2) throw e2;
    if ((dayCount || 0) >= USER_PER_DAY) {
      return { allowed: false, used: dayCount, limit: USER_PER_DAY, window: 'day' };
    }
    await admin.from('transcribe_usage').insert({ actor, kind: 'ai', created_at: new Date(now).toISOString() });
    return { allowed: true };
  } catch (e) {
    console.warn('ai-goal rate-limit degraded:', e.message);
    return { allowed: true, degraded: true };
  }
}

// ---- The goal-setting prompt ------------------------------------------------
function systemPrompt(roles, values) {
  return [
    "You help a person turn what matters to them into a few meaningful, MEASURABLE long-term goals, using values-based planning.",
    roles.length ? `Their life roles are: ${roles.join(', ')}.` : 'They have not defined life roles.',
    values.length ? `Their stated values are: ${values.join(', ')}.` : 'They have not defined values.',
    'Rules:',
    '- Propose 1 to 5 goals, drawn ONLY from what they said. Do not invent ambitions they did not express.',
    '- Each goal must be measurable: "name" is the goal in their own words, tidied; "tot" is the whole-number target that measures it (books to read, km to run, sessions, dollars saved — pick the natural unit from their words; use 1 for a single-completion goal).',
    "- \"role\" links the goal to EXACTLY ONE of their life roles listed above, copied verbatim, or \"\" when none fits. Never link to a role that is not in the list.",
    '- "why" is ONE short sentence connecting the goal to their words or values — shown to them for the decision, so keep it honest and plain.',
    '- Fewer, better goals beat many. If they said one thing, propose one goal.',
    'Respond with the JSON object only.',
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  name: 'goal_proposal',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      goals: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string' },
            tot: { type: 'integer' },
            role: { type: 'string' },
            why: { type: 'string' },
          },
          required: ['name', 'tot', 'role', 'why'],
        },
      },
    },
    required: ['goals'],
  },
};

// ---- Validation: NOTHING malformed ever reaches the UI ----------------------
const NULLISH_RE = /^(null|undefined|none|n\/a|nil|-)$/i;
const clean = (v, max) => {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return NULLISH_RE.test(t) ? '' : t;
};

// Exported for the test harness. Individually broken goals are dropped, not
// "fixed"; a role not in the caller's own list is stripped to '' — the model
// may never attach a goal to a role the person does not have.
export function validateGoalProposal(raw, roles) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.goals)) return null;
  const roleSet = new Set((Array.isArray(roles) ? roles : []).map(r => String(r)));
  const goals = [];
  for (const g of raw.goals.slice(0, MAX_GOALS)) {
    if (!g || typeof g !== 'object') continue;
    const name = clean(g.name, MAX_TEXT);
    if (!name) continue;
    let tot = Number.isInteger(g.tot) ? g.tot : parseInt(g.tot, 10);
    if (!Number.isInteger(tot) || tot < 1) tot = 1;
    if (tot > MAX_TOT) tot = MAX_TOT;
    const roleRaw = clean(g.role, MAX_TEXT);
    const role = roleSet.has(roleRaw) ? roleRaw : '';
    goals.push({ name, tot, role, why: clean(g.why, MAX_WHY) });
  }
  if (!goals.length) return null;
  return { goals };
}

// ---- Handler ----------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    // 1. Who is calling? (strict — no anonymous mode on a Pro feature)
    const userId = await identify(req);
    if (!userId) return res.status(401).json({ error: 'Sign in to use AI goal setting' });

    // 2. Are they Pro?
    if (!(await isPro(userId))) {
      return res.status(403).json({ error: 'AI goal setting is a Pro feature', code: 'not_pro' });
    }

    // 3. Over the ceiling?
    const gate = await checkAndRecord(userId);
    if (!gate.allowed) {
      console.warn(`ai-goal rate-limited actor=${userId} used=${gate.used}/${gate.limit} per ${gate.window}`);
      res.setHeader('Retry-After', gate.window === 'day' ? '3600' : '600');
      return res.status(429).json({ error: `AI limit reached (${gate.limit} per ${gate.window}). Try again shortly.` });
    }

    // 4. Input
    const { text, roles, values } = req.body || {};
    const dump = clean(text, MAX_INPUT);
    if (!dump || dump.length < 3) return res.status(400).json({ error: 'Say what matters to you first' });
    const roleNames = (Array.isArray(roles) ? roles : []).map(r => clean(String(r), 80)).filter(Boolean).slice(0, 20);
    const valueNames = (Array.isArray(values) ? values : []).map(v => clean(String(v), 80)).filter(Boolean).slice(0, 20);
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY' });

    // 5. One goal-setting call
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        messages: [
          { role: 'system', content: systemPrompt(roleNames, valueNames) },
          { role: 'user', content: dump },
        ],
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error(`ai-goal upstream fail actor=${userId} status=${r.status}`);
      return res.status(502).json({ error: 'Could not draft goals — try again', detail: detail.slice(0, 300) });
    }

    const data = await r.json();
    let parsed = null;
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || ''); } catch (e) { parsed = null; }

    // 6. Validate — malformed output fails LOUD, never a silent write.
    const proposal = validateGoalProposal(parsed, roleNames);
    if (!proposal) {
      console.error(`ai-goal invalid-output actor=${userId}`);
      return res.status(502).json({ error: 'Could not draft goals — try again' });
    }

    // 7. Cost logging (same priced band as ai-structure)
    const u = data.usage || {};
    console.log(`ai-goal ok actor=${userId} model=${MODEL} in=${u.prompt_tokens || 0} out=${u.completion_tokens || 0} goals=${proposal.goals.length}`);

    return res.status(200).json(proposal);
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
