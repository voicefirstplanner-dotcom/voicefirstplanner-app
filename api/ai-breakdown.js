// api/ai-breakdown.js
// Pro Phase 2 — AI weekly action breakdown (4 Aug). Receives ONE of the
// person's long-term goals (name, progress, linked role) plus any guidance
// they spoke, and returns a PROPOSAL of concrete tasks for the coming seven
// days, in the app's exact task shape.
//
//   Request  (POST, JSON):  { today: "YYYY-MM-DD", goalName, goalProgress: "cur/tot",
//                             role, notes }
//            Header:        Authorization: Bearer <supabase access token>  (REQUIRED)
//   Response (JSON):        { tasks: [ { text, p, date } ] }
//
// ⛔ THE TRUST BOUNDARY, SERVER SIDE — identical to /api/ai-structure: this
// endpoint NEVER writes to anyone's planner. It returns a proposal; committing
// happens in the client behind the review sheet's explicit "Add to planner".
//
// Task shape (must match the manual add exactly; ids/done assigned at commit):
//   task { text, p: 'A'|'B'|'C', date: 'YYYY-MM-DD'|null }
//
// Dates use the ai-structure lineage wholesale: the model EXTRACTS a dayRef
// expression; the SERVER does the arithmetic (resolveDayRef, cloned verbatim),
// so instruction-following is not load-bearing for dates here either.
//
// Security model, rate limits (transcribe_usage kind='ai' — shared AI ceiling),
// Pro gate: all cloned verbatim from /api/ai-structure.

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// ---- Model. One line, so a future swap stays a one-line change. ----
const MODEL = 'gpt-4o-mini';

// ---- Ceilings — the same shared 'ai' bucket as ai-structure ----
const USER_PER_HOUR = 30;
const USER_PER_DAY  = 100;

// ---- Proposal caps ----
const MAX_TASKS = 10;       // a week's worth, not a backlog
const MAX_TEXT  = 200;
const MAX_INPUT = 2000;

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
    console.warn('ai-breakdown rate-limit degraded:', e.message);
    return { allowed: true, degraded: true };
  }
}

// ---- Prompt -----------------------------------------------------------------
// Cloned date discipline from ai-structure: weekday context + dayRef extraction.
export function weekdayOf(dateKey) {
  return new Date(dateKey + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}
function systemPrompt(today, goalName, goalProgress, role) {
  const wd = weekdayOf(today);
  return [
    'You break ONE long-term goal into specific, small action steps for the coming seven days.',
    `The goal: "${goalName}"${goalProgress ? ` (progress so far: ${goalProgress})` : ''}${role ? `, linked to their "${role}" life role` : ''}.`,
    `Today is ${wd}, ${today}.`,
    'Rules:',
    '- Propose 3 to 7 tasks. Each must be a single concrete action someone can finish in one sitting, phrased as a to-do.',
    '- Spread them sensibly across the NEXT SEVEN DAYS starting today. For EVERY task set dayRef to the day expression ("today", "tomorrow", "Wednesday", "by Sunday") — copy words, never resolve dates yourself. Use null only for a genuinely day-free task.',
    '- Priority: "A" only for a step the goal stalls without this week, "C" for optional extras, otherwise "B".',
    '- Honor any guidance in the user message (days to avoid, pace, focus areas).',
    '- Do not invent resources, people or commitments they did not mention.',
    'Respond with the JSON object only.',
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  name: 'breakdown_proposal',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            text: { type: 'string' },
            p: { type: 'string', enum: ['A', 'B', 'C'] },
            date: { type: ['string', 'null'] },
            dayRef: { type: ['string', 'null'] },
          },
          required: ['text', 'p', 'date', 'dayRef'],
        },
      },
    },
    required: ['tasks'],
  },
};

// ---- Validation — the ai-structure task validator lineage, verbatim ---------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NULLISH_RE = /^(null|undefined|none|n\/a|nil|-)$/i;
const clean = (v, max) => {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return NULLISH_RE.test(t) ? '' : t;
};

const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function addDays(dateKeyStr, n) {
  const d = new Date(dateKeyStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function resolveDayRef(dayRef, today) {
  if (typeof dayRef !== 'string' || !DATE_RE.test(today)) return null;
  const t = dayRef.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || NULLISH_RE.test(t)) return null;
  if (t === 'today' || t === 'tonight' || t === 'this evening' || t === 'this afternoon' || t === 'this morning') return today;
  if (t === 'tomorrow' || t.startsWith('tomorrow ')) return addDays(today, 1);
  if (t === 'day after tomorrow' || t === 'the day after tomorrow') return addDays(today, 2);
  const m = t.match(/^(?:(by|on|next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (!m) return null;
  const mode = m[1] || '';
  const target = WEEKDAYS.indexOf(m[2]);
  const todayDow = new Date(today + 'T12:00:00Z').getUTCDay();
  let diff = (target - todayDow + 7) % 7;
  if (mode === 'by') {
    return addDays(today, diff);
  }
  if (mode === 'this') {
    if (diff === 0) return addDays(today, 7);
    const mondayAnchoredToday = (todayDow + 6) % 7;
    const mondayAnchoredTarget = (target + 6) % 7;
    return (mondayAnchoredTarget > mondayAnchoredToday) ? addDays(today, diff) : addDays(today, diff === 0 ? 7 : diff);
  }
  if (diff === 0) diff = 7;
  return addDays(today, diff);
}

// Exported for the test harness. Broken tasks are dropped, not "fixed".
export function validateBreakdown(raw, today) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) return null;
  const tasks = [];
  for (const t of raw.tasks.slice(0, MAX_TASKS)) {
    if (!t || typeof t !== 'object') continue;
    const text = clean(t.text, MAX_TEXT);
    if (!text) continue;
    const p = ['A', 'B', 'C'].includes(t.p) ? t.p : 'B';
    let date = (typeof t.date === 'string' && DATE_RE.test(t.date)) ? t.date : null;
    const snapped = resolveDayRef(t.dayRef, today);
    if (snapped) date = snapped;   // deterministic arithmetic beats the model's
    tasks.push({ text, p, date });
  }
  if (!tasks.length) return null;
  return { tasks };
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
    if (!userId) return res.status(401).json({ error: 'Sign in to use AI breakdown' });

    // 2. Are they Pro?
    if (!(await isPro(userId))) {
      return res.status(403).json({ error: 'AI weekly breakdown is a Pro feature', code: 'not_pro' });
    }

    // 3. Over the ceiling?
    const gate = await checkAndRecord(userId);
    if (!gate.allowed) {
      console.warn(`ai-breakdown rate-limited actor=${userId} used=${gate.used}/${gate.limit} per ${gate.window}`);
      res.setHeader('Retry-After', gate.window === 'day' ? '3600' : '600');
      return res.status(429).json({ error: `AI limit reached (${gate.limit} per ${gate.window}). Try again shortly.` });
    }

    // 4. Input
    const { today, goalName, goalProgress, role, notes } = req.body || {};
    const gName = clean(goalName, MAX_TEXT);
    if (!gName) return res.status(400).json({ error: 'Pick a goal to break down' });
    const todayKey = (typeof today === 'string' && DATE_RE.test(today))
      ? today
      : new Date().toISOString().slice(0, 10);
    const guidance = clean(notes, MAX_INPUT);
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY' });

    // 5. One breakdown call
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
          { role: 'system', content: systemPrompt(todayKey, gName, clean(goalProgress, 40), clean(role, 80)) },
          { role: 'user', content: guidance || 'No extra guidance — spread the steps sensibly across the week.' },
        ],
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error(`ai-breakdown upstream fail actor=${userId} status=${r.status}`);
      return res.status(502).json({ error: 'Could not break this down — try again', detail: detail.slice(0, 300) });
    }

    const data = await r.json();
    let parsed = null;
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || ''); } catch (e) { parsed = null; }

    // 6. Validate — malformed output fails LOUD, never a silent write.
    const proposal = validateBreakdown(parsed, todayKey);
    if (!proposal) {
      console.error(`ai-breakdown invalid-output actor=${userId}`);
      return res.status(502).json({ error: 'Could not break this down — try again' });
    }

    // 7. Cost logging (same priced band as ai-structure)
    const u = data.usage || {};
    console.log(`ai-breakdown ok actor=${userId} model=${MODEL} in=${u.prompt_tokens || 0} out=${u.completion_tokens || 0} tasks=${proposal.tasks.length}`);

    return res.status(200).json(proposal);
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
