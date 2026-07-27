// api/ai-structure.js
// P1 — Pro AI brain-dump structuring (Stage 4 of the calendar → P1 run).
// Receives free text (typed, or transcribed by /api/transcribe) and returns a
// STRUCTURED PROPOSAL: tasks and appointments in the app's exact shapes.
//
//   Request  (POST, JSON):  { text: "the brain dump", today: "YYYY-MM-DD" }
//            Header:        Authorization: Bearer <supabase access token>  (REQUIRED)
//   Response (JSON):        { tasks: [...], appointments: [...] }
//
// ⛔ THE TRUST BOUNDARY, SERVER SIDE: this endpoint NEVER writes to anyone's
// planner. It returns a proposal and nothing else. Committing approved items
// to state happens in the client, behind the review sheet's explicit
// "Add to planner" — there is no server path around that approval.
//
// Shapes (must match the Stage-1 schema exactly — nothing renders outside it):
//   task        { text, p: 'A'|'B'|'C', date: 'YYYY-MM-DD'|null }
//   appointment { title, date: 'YYYY-MM-DD', timeStart: 'HH:MM'|'', timeEnd: 'HH:MM'|'',
//                 with: '', location: '', notes: '', allDay: boolean }
// (ids/done/etc. are assigned client-side at commit, same as manual adds.)
//
// Security model = the proven transcribe.js pattern: Supabase JWT identifies
// the caller; per-user rate limits ride the existing transcribe_usage table
// (kind='ai', so voice and AI ceilings never couple); every call is logged
// with token usage for the cost band. Pro entitlement is checked against the
// entitlements table — Lifetime is Premium, NOT Pro, and does not pass.
//
// AI_TEST_USER_IDS (env, comma-separated Supabase user ids): lets named
// accounts through the Pro gate before Pro checkout exists — the live-confirm
// path. Remove or empty it once Pro is purchasable.

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// ---- Model. One line, so a future swap stays a one-line change. ----
const MODEL = 'gpt-4o-mini';

// ---- Ceilings. A heavy real user brain-dumps a handful of times a day. ----
const USER_PER_HOUR = 30;
const USER_PER_DAY  = 100;

// ---- Proposal caps — the validator's hard ceilings, whatever the model says. ----
const MAX_ITEMS = 20;          // per list
const MAX_TEXT  = 200;         // chars per task text / appt title
const MAX_FIELD = 300;         // chars per with/location/notes
const MAX_INPUT = 4000;        // chars of brain-dump accepted

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
    console.warn('ai-structure rate-limit degraded:', e.message);
    return { allowed: true, degraded: true };
  }
}

// ---- The structuring prompt -------------------------------------------------
// Fix 2 (27 Jul): the model must know the WEEKDAY, not just the date — a dump
// on "Sunday 26 July" said "dentist Tuesday at 2" and came back a Sunday.
// Exported for the fixture harness.
export function weekdayOf(dateKey) {
  return new Date(dateKey + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}
function systemPrompt(today) {
  const wd = weekdayOf(today);
  return [
    'You turn a person\'s spoken or typed brain dump into structured planner items.',
    `Today is ${wd}, ${today}. Resolve every relative date against that exact day:`,
    `- "tomorrow" = the day after ${today}.`,
    '- A bare weekday name ("Tuesday", "on Tuesday", "next Tuesday") = the FIRST such weekday STRICTLY AFTER today.',
    '- "by <weekday>" = the first such weekday on or after today (a deadline lands ON that day).',
    '- "this <weekday>" = the one inside the current Mon-Sun week if still ahead, otherwise the next one.',
    '- Double-check the arithmetic: the produced date\'s weekday must match the word used.',
    '- For EVERY item, also set dayRef to the exact relative day expression from the text ("tomorrow", "Tuesday", "by Friday", "next Monday") or null when an explicit date was given or no day was mentioned. Copy the words; do not resolve them in dayRef.',
    'Rules:',
    '- Every actionable item becomes ONE task or ONE appointment. Do not invent items that are not in the text.',
    '- An APPOINTMENT is anything at a specific time or with a person/place attached (meetings, calls, bookings). Everything else is a TASK.',
    '- Task priority: "A" if the text marks it urgent/important/must-do, "C" if explicitly someday/low, otherwise "B".',
    '- Dates are "YYYY-MM-DD". A task with no stated day gets date null. An appointment with no stated day gets today.',
    '- Times are 24h "HH:MM". An appointment with a stated time gets timeStart (and timeEnd if stated or clearly implied, e.g. "an hour with"). If a whole-day event ("all day", "conference on Friday"), set allDay true and leave times empty.',
    '- "with" is the person named for the appointment, if any. location and notes only when stated. Never fabricate.',
    '- Keep the person\'s own wording for task text and appointment titles, trimmed and tidied.',
    'Respond with the JSON object only.'
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  name: 'planner_proposal',
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
      appointments: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' },
            date: { type: 'string' },
            timeStart: { type: 'string' },
            timeEnd: { type: 'string' },
            with: { type: 'string' },
            location: { type: 'string' },
            notes: { type: 'string' },
            allDay: { type: 'boolean' },
            dayRef: { type: ['string', 'null'] },
          },
          required: ['title', 'date', 'timeStart', 'timeEnd', 'with', 'location', 'notes', 'allDay', 'dayRef'],
        },
      },
    },
    required: ['tasks', 'appointments'],
  },
};

// ---- Validation: NOTHING malformed ever reaches the UI ----------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Model-emitted junk for "no value" must never render in a field (the literal
// "null" that reached the With input, 27 Jul).
const NULLISH_RE = /^(null|undefined|none|n\/a|nil|-)$/i;
const clean = (v, max) => {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return NULLISH_RE.test(t) ? '' : t;
};

// ---- Deterministic relative-day resolution (Fix, 27 Jul) --------------------
// The model EXTRACTS the expression (dayRef); the server does the arithmetic.
// "by Friday" → the first Friday ON OR AFTER today. Bare/on/next <weekday> →
// the first such weekday STRICTLY AFTER today. "this <weekday>" → within the
// current Mon–Sun week if still ahead, else the next one. Instruction-following
// is no longer load-bearing for dates. Exported for the fixture harness.
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
    // deadline lands ON that day; "by Monday" said on a Monday = today
    return addDays(today, diff);
  }
  if (mode === 'this') {
    // inside the current Mon–Sun week if still ahead, else the next one
    if (diff === 0) return addDays(today, 7);
    const mondayAnchoredToday = (todayDow + 6) % 7;            // Mon=0
    const mondayAnchoredTarget = (target + 6) % 7;
    return (mondayAnchoredTarget > mondayAnchoredToday) ? addDays(today, diff) : addDays(today, diff === 0 ? 7 : diff);
  }
  // bare / "on" / "next": first such weekday strictly after today
  if (diff === 0) diff = 7;
  return addDays(today, diff);
}

// Exported for the test harness. Returns { tasks, appointments } or null when
// the payload is unusable. Individually broken items are dropped, not "fixed".
export function validateProposal(raw, today) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.tasks) || !Array.isArray(raw.appointments)) return null;

  const tasks = [];
  for (const t of raw.tasks.slice(0, MAX_ITEMS)) {
    if (!t || typeof t !== 'object') continue;
    const text = clean(t.text, MAX_TEXT);
    if (!text) continue;
    const p = ['A', 'B', 'C'].includes(t.p) ? t.p : 'B';
    let date = (typeof t.date === 'string' && DATE_RE.test(t.date)) ? t.date : null;
    const snapped = resolveDayRef(t.dayRef, today);
    if (snapped) date = snapped;   // deterministic arithmetic beats the model's
    tasks.push({ text, p, date });
  }

  const appointments = [];
  for (const a of raw.appointments.slice(0, MAX_ITEMS)) {
    if (!a || typeof a !== 'object') continue;
    const title = clean(a.title, MAX_TEXT);
    if (!title) continue;
    let date = (typeof a.date === 'string' && DATE_RE.test(a.date)) ? a.date : today;
    const snapped = resolveDayRef(a.dayRef, today);
    if (snapped) date = snapped;
    const allDay = a.allDay === true;
    let timeStart = (typeof a.timeStart === 'string' && TIME_RE.test(a.timeStart)) ? a.timeStart : '';
    let timeEnd   = (typeof a.timeEnd   === 'string' && TIME_RE.test(a.timeEnd))   ? a.timeEnd   : '';
    if (allDay) { timeStart = ''; timeEnd = ''; }
    if (!allDay && !timeStart && timeEnd) { timeStart = timeEnd; timeEnd = ''; }
    if (timeStart && timeEnd && timeEnd <= timeStart) timeEnd = '';
    appointments.push({
      title, date, timeStart, timeEnd,
      with: clean(a.with, MAX_FIELD),
      location: clean(a.location, MAX_FIELD),
      notes: clean(a.notes, MAX_FIELD),
      allDay,
    });
  }

  if (!tasks.length && !appointments.length) return null;
  return { tasks, appointments };
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
    if (!userId) return res.status(401).json({ error: 'Sign in to use AI structuring' });

    // 2. Are they Pro?
    if (!(await isPro(userId))) {
      return res.status(403).json({ error: 'AI structuring is a Pro feature', code: 'not_pro' });
    }

    // 3. Over the ceiling?
    const gate = await checkAndRecord(userId);
    if (!gate.allowed) {
      console.warn(`ai-structure rate-limited actor=${userId} used=${gate.used}/${gate.limit} per ${gate.window}`);
      res.setHeader('Retry-After', gate.window === 'day' ? '3600' : '600');
      return res.status(429).json({ error: `AI limit reached (${gate.limit} per ${gate.window}). Try again shortly.` });
    }

    // 4. Input
    const { text, today } = req.body || {};
    const dump = clean(text, MAX_INPUT);
    if (!dump || dump.length < 3) return res.status(400).json({ error: 'Nothing to structure' });
    const todayKey = (typeof today === 'string' && DATE_RE.test(today))
      ? today
      : new Date().toISOString().slice(0, 10);
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY' });

    // 5. One structuring call
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        messages: [
          { role: 'system', content: systemPrompt(todayKey) },
          { role: 'user', content: dump },
        ],
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error(`ai-structure upstream fail actor=${userId} status=${r.status}`);
      return res.status(502).json({ error: 'Could not structure this — try again', detail: detail.slice(0, 300) });
    }

    const data = await r.json();
    let parsed = null;
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || ''); } catch (e) { parsed = null; }

    // 6. Validate — malformed output fails LOUD, never a silent write.
    const proposal = validateProposal(parsed, todayKey);
    if (!proposal) {
      console.error(`ai-structure invalid-output actor=${userId}`);
      return res.status(502).json({ error: 'Could not structure this — try again' });
    }

    // 7. Cost logging (the priced band: fractions of a cent per call)
    const u = data.usage || {};
    console.log(`ai-structure ok actor=${userId} model=${MODEL} in=${u.prompt_tokens || 0} out=${u.completion_tokens || 0} tasks=${proposal.tasks.length} appts=${proposal.appointments.length}`);

    return res.status(200).json(proposal);
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
