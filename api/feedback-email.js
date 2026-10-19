// ---------------------------------------------------------------------------
// FEEDBACK EMAIL  (19 Oct 2026 · brief Feedback_Email v1)   shared, non-routable
//
// Every piece of feedback a signed-in member sends from the app is emailed to
// Dave, as well as saved in the `feedback` table as before. The app saves the
// row first, exactly as it always has; only when that save has succeeded does it
// ask for this email, and it never waits for the answer. So if this fails, the
// row is still saved and the member sees exactly what they saw before.
//
// Why it lives here, not in its own api/ file: Vercel's Hobby plan allows 12
// functions per deployment and api/ already holds 12 (see capture.js, 2 Sep).
// A 13th file would fail every deploy. library-download.js hands a POST that
// carries `feedback` to sendFeedbackEmail() before anything else it does; every
// other request to it is untouched. This file sits under api/_lib/, so Vercel
// does not turn it into a function of its own.
//
// Sent with Resend, the service the app already uses for its own emails
// (user-confirmed.js), with the same RESEND_API_KEY. No new setting is needed.
//
// Guards, so this cannot be used to send mail anywhere else or at will:
//  · the caller must be signed in (their Supabase token is checked here);
//  · the email goes to one fixed address, never one the caller gives;
//  · it is sent only for a feedback row that is really saved under the caller's
//    account, with the same kind and the same words, and (when the row records
//    its time) saved in the last 15 minutes;
//  · one email per saved row: Resend's Idempotency-Key is built from the row.
// Nothing is written to the database here. What is stored is unchanged.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO   = process.env.FEEDBACK_EMAIL_TO   || 'dave@voicefirstdayplanner.com';
const FROM = process.env.FEEDBACK_EMAIL_FROM || 'VoiceFirstPlanner Feedback <feedback@voicefirstdayplanner.com>';
const RECENT_MINUTES = 15;
const MAX_MESSAGE = 20000;   // far longer than anyone types into the sheet
const LOOKUP_WHOLE = 1500;   // up to this length the saved row is looked up by the whole message
const LOOKUP_PREFIX = 300;   // longer: by its opening words, then compared in full

// The kinds as the feedback sheet names them (its three buttons).
export const KINDS = { good: 'Good', bug: 'Problem', idea: 'Idea' };

// The app's sections, by the names on its own tab buttons.
const TABS = {
  daily: 'Daily', week: 'Week', month: 'Month', year: 'Year', projects: 'Projects',
  notes: 'Notes', shopping: 'Shopping', budget: 'Budget', values: 'Values',
  goals: 'Goals', bucket: 'Bucket List', habits: 'Habits', reflect: 'Reflect',
};

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A short, readable device line from the browser's own description of itself.
export function deviceLine(ua, standalone) {
  ua = String(ua || '');
  let device = 'Unknown device';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) device = 'iPad';
  else if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
  else if (/Windows/.test(ua)) device = 'Windows PC';
  else if (/CrOS/.test(ua)) device = 'Chromebook';
  else if (/Linux/.test(ua)) device = 'Linux';
  let browser = '';
  let m;
  if ((m = /Edg(?:iOS|A)?\/(\d+)/.exec(ua))) browser = 'Edge ' + m[1];
  else if ((m = /(?:CriOS|Chrome)\/(\d+)/.exec(ua))) browser = 'Chrome ' + m[1];
  else if ((m = /(?:FxiOS|Firefox)\/(\d+)/.exec(ua))) browser = 'Firefox ' + m[1];
  else if (/Safari\//.test(ua) && (m = /Version\/(\d+(?:\.\d+)?)/.exec(ua))) browser = 'Safari ' + m[1];
  else if (/AppleWebKit/.test(ua)) browser = 'Safari';
  return device + (browser ? ' · ' + browser : '') + (standalone ? ' · Home Screen app' : '');
}

// The date and time in New Zealand (where Dave reads it), e.g. "Mon 19 Oct 2026, 6:42 pm NZDT".
export function nzTime(d) {
  const parts = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod || '').toLowerCase()} ${parts.timeZoneName || ''}`.replace(/\s+/g, ' ').trim();
}

// The newest of the matching saved rows (by created_at when the table records it, else by id).
function newest(rows) {
  const t = r => (r && r.created_at ? Date.parse(r.created_at) : NaN);
  const copy = rows.slice();
  copy.sort((a, b) => {
    const ta = t(a), tb = t(b);
    if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return tb - ta;
    const ia = Number(a && a.id), ib = Number(b && b.id);
    if (!isNaN(ia) && !isNaN(ib)) return ib - ia;
    return 0;
  });
  return copy[0];
}

export function buildEmail({ kind, message, accountEmail, accountName, tab, view, when, memberTz, ua, standalone, ver }) {
  const kindName = KINDS[kind] || kind;
  const snippet = message.replace(/\s+/g, ' ').trim();
  const short = snippet.length > 60 ? snippet.slice(0, 57).trimEnd() + '…' : snippet;
  const subject = `Feedback · ${kindName} · "${short}"`;
  const tabName = tab ? (TABS[tab] || tab) + (view === 'planner' ? ' (Planner view)' : '') : 'Not known';
  const whenNz = nzTime(when);
  const tzLine = memberTz && memberTz !== 'Pacific/Auckland' ? ` (their time zone: ${memberTz})` : '';
  const device = deviceLine(ua, standalone);
  const who = accountName ? `${accountName} · ${accountEmail}` : accountEmail;
  const rows = [
    ['Kind', kindName],
    ['From', who + ' — reply to this email to answer them'],
    ['Page', tabName],
    ['Sent', whenNz + tzLine],
    ['Device', device],
  ];
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#F0F5FB;font-family:Helvetica,Arial,sans-serif;color:#2C2C2A;">
<div style="max-width:600px;margin:24px auto;background:#ffffff;border-radius:10px;overflow:hidden;">
<div style="background:#0C447C;height:6px;"></div>
<div style="padding:24px 28px;">
<div style="font-size:13px;color:#5F5E5A;margin:0 0 4px;">VoiceFirstPlanner · feedback from the app</div>
<h1 style="font-size:22px;color:#0C447C;margin:0 0 18px;">${esc(kindName)}</h1>
<div style="font-size:16px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;background:#F7F9FC;border-left:4px solid #F2771A;padding:14px 16px;margin:0 0 20px;">${esc(message)}</div>
<table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;line-height:1.5;border-collapse:collapse;">
${rows.map(([k, v]) => `<tr><td style="width:84px;padding:6px 10px 6px 0;color:#5F5E5A;vertical-align:top;font-weight:700;">${esc(k)}</td><td style="padding:6px 0;vertical-align:top;">${k === 'From' ? `<a href="mailto:${esc(accountEmail)}" style="color:#0C447C;">${esc(who)}</a> — reply to this email to answer them` : esc(v)}</td></tr>`).join('\n')}
</table>
<div style="font-size:12px;color:#888780;margin:20px 0 0;line-height:1.5;">Saved in the feedback table as before. App ${esc(ver || '')} · browser: ${esc(ua || 'not given')}</div>
</div></div></body></html>`;
  const text = [
    `VoiceFirstPlanner · feedback from the app`,
    ``,
    `Kind: ${kindName}`,
    ``,
    message,
    ``,
    `From: ${who} (reply to this email to answer them)`,
    `Page: ${tabName}`,
    `Sent: ${whenNz}${tzLine}`,
    `Device: ${device}`,
    ``,
    `Saved in the feedback table as before. App ${ver || ''} · browser: ${ua || 'not given'}`,
  ].join('\n');
  return { subject, html, text };
}

// Handles POST { feedback: { kind, message, tab, view, tz, standalone } } with the member's
// Supabase token. `supabase` is the service-role client of the calling route.
// deps (for the room's tests only): { fetch, now }.
export async function sendFeedbackEmail(req, res, supabase, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const now = deps.now ? deps.now() : new Date();
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Sign in first' });
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.id) return res.status(401).json({ error: 'Sign in first' });
    const user = userData.user;

    const fb = (req.body && req.body.feedback) || {};
    const kind = typeof fb.kind === 'string' ? fb.kind : '';
    const message = typeof fb.message === 'string' ? fb.message.trim() : '';
    if (!KINDS[kind] || !message || message.length > MAX_MESSAGE) return res.status(400).json({ error: 'Not a feedback message' });

    // Only for a row the app really saved for this member, with these words. A long message
    // is looked up by its opening words (a whole long message would make the request address
    // too long), then compared in full here.
    let q = supabase.from('feedback').select('*').eq('user_id', user.id).eq('kind', kind);
    q = message.length <= LOOKUP_WHOLE
      ? q.eq('message', message)
      : q.like('message', message.slice(0, LOOKUP_PREFIX).replace(/[\\%_]/g, c => '\\' + c) + '%');
    const { data: hits, error: findErr } = await q.limit(20);
    if (findErr) { console.error('feedback-email: lookup failed', findErr.message); return res.status(500).json({ error: 'lookup failed' }); }
    const found = (hits || []).filter(r => r && String(r.message || '').trim() === message);
    if (!found.length) return res.status(404).json({ error: 'No saved feedback matches' });
    const row = newest(found);
    if (row.created_at && !isNaN(Date.parse(row.created_at))
        && now.getTime() - Date.parse(row.created_at) > RECENT_MINUTES * 60e3) {
      return res.status(409).json({ error: 'Feedback is not recent' });
    }

    if (!RESEND_API_KEY && !deps.fetch) { console.error('feedback-email: RESEND_API_KEY is not set'); return res.status(500).json({ error: 'email not set up' }); }

    const ctx = (row.context && typeof row.context === 'object') ? row.context : {};
    const email = buildEmail({
      kind, message: row.message || message,
      accountEmail: user.email || '(no email on the account)',
      accountName: (user.user_metadata && (user.user_metadata.name || user.user_metadata.full_name)) || '',
      tab: (typeof fb.tab === 'string' && fb.tab) || ctx.tab || null,
      view: fb.view === 'planner' ? 'planner' : 'classic',
      when: row.created_at && !isNaN(Date.parse(row.created_at)) ? new Date(row.created_at) : now,
      memberTz: typeof fb.tz === 'string' ? fb.tz.slice(0, 64) : '',
      ua: ctx.ua || (req.headers['user-agent'] || ''),
      standalone: !!fb.standalone,
      ver: ctx.ver || '',
    });
    const key = 'feedback-' + crypto.createHash('sha256')
      .update([user.id, row.id ?? '', row.created_at ?? '', kind, message].join('|')).digest('hex').slice(0, 40);

    const body = { from: FROM, to: [TO], subject: email.subject, html: email.html, text: email.text };
    if (user.email) body.reply_to = user.email;
    const send = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    if (!send.ok) {
      const detail = await send.text().catch(() => '');
      console.error('feedback-email: send failed', send.status, detail.slice(0, 200));
      return res.status(502).json({ error: 'send failed' });
    }
    console.log('feedback-email: sent', kind, 'user=', user.id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('feedback-email error:', err && err.message || err);
    return res.status(500).json({ error: 'failed' });
  }
}
