// ---------------------------------------------------------------------------
// api/capture.js: EMAIL CAPTURE, RUNG ONE OF THE LADDER (2 Sep 2026)
//
// An address gets the workbook. A free account gets the three books. Paid gets
// the rest. THIS FILE IS RUNG ONE ONLY: no account is created, no entitlement
// is written, no card is involved, and nothing here reads or touches
// library-download.js, the entitlements table, or founding_number. It is a
// separate, free path and it stays that way.
//
// The form lives on the marketing site; this endpoint lives on the app, so the
// only origin allowed through CORS is the marketing domain.
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { mintToken, verifyToken } from './_lib/token.js';

const admin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Dave <dave@voicefirstdayplanner.com>';
const ALLOWED_ORIGIN = process.env.CAPTURE_ALLOWED_ORIGIN || 'https://voicefirstdayplanner.com';
const audienceId = () => process.env.RESEND_AUDIENCE_ID || '';   // read at call time
const APP_BASE = 'https://app.voicefirstdayplanner.com';
const SITE = 'voicefirstdayplanner.com';

// Page slugs a form may declare. Anything not on this list is recorded as
// 'start' rather than rejected: a mistyped slug must not cost us the address.
// Persona slugs are appended here as those pages ship.
const ALLOWED_SOURCES = ['start'];

// Per IP, 5 per hour, on the shared transcribe_usage table as kind='capture'.
// transcribe.js already excludes non-voice kinds from its own ceilings, so this
// cannot eat into anyone's voice allowance.
const PER_HOUR = 5;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Salted with LIBRARY_TOKEN_SECRET so the raw IP never reaches the database and
// a bare hash cannot be reversed: the whole IPv4 space is small enough to
// rainbow-table in seconds without a salt.
function hashWithSecret(value) {
  const secret = process.env.LIBRARY_TOKEN_SECRET || '';
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

// The token subject. The address itself never travels in the URL; the subject
// is a one-way hash of it, and `subject_hash` on the captures row is what lets
// workbook-download.js find the right row again.
function subjectFor(email) {
  return 'wb:' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
}

// Deliberately permissive: one @, something either side, a dot in the domain,
// no spaces. Anything stricter rejects real addresses, and the only cost of a
// plausible-but-wrong address is one bounced email.
function validEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s || s.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

async function rateLimited(actor) {
  if (!admin) return false;                       // fail OPEN, as transcribe does
  try {
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const { count, error } = await admin
      .from('transcribe_usage')
      .select('id', { count: 'exact', head: true })
      .eq('actor', actor)
      .eq('kind', 'capture')
      .gte('created_at', hourAgo);
    if (error) throw error;
    if ((count || 0) >= PER_HOUR) return true;
    await admin.from('transcribe_usage').insert({ actor, kind: 'capture', created_at: new Date().toISOString() });
    return false;
  } catch (e) {
    console.warn('capture rate-limit degraded:', e.message);
    return false;
  }
}

// Resend contacts. The account is expected on the global Contacts model
// (contacts are global, segments are optional, custom properties supported).
// If this account has not migrated, POST /contacts answers 404 and we fall back
// to the audience path: which needs RESEND_AUDIENCE_ID. Which one actually
// fired is logged, so the delivery can report it rather than assume it.
async function upsertContact(email, source, capturedAt) {
  const headers = { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  const properties = { source, captured_at: capturedAt };
  const read = async r => { try { return (await r.text()).slice(0, 300); } catch (e) { return ''; } };

  // First live capture (2 Sep): POST /contacts answered a validation error, the
  // code misread it as "already exists" and PATCHed a contact that was never
  // created, which 404'd. Two corrections. (1) Only 409 means exists; anything
  // else is a refusal and its body is logged verbatim so the record says why.
  // (2) Custom properties must be defined in Resend > Audience > Properties
  // before the API will accept them. If they are refused, the contact is
  // stored again WITHOUT them, so rung one is always counted in Resend and the
  // properties are best effort until Dave defines them.
  let r = await fetch('https://api.resend.com/contacts', {
    method: 'POST', headers, body: JSON.stringify({ email, unsubscribed: false, properties }),
  });
  if (r.ok) return { ok: true, model: 'contacts', action: 'created', properties: true };

  if (r.status === 409) {
    const u = await fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}`, {
      method: 'PATCH', headers, body: JSON.stringify({ unsubscribed: false, properties }),
    });
    if (u.ok) return { ok: true, model: 'contacts', action: 'updated', properties: true };
    return { ok: false, model: 'contacts', step: 'patch', status: u.status, body: await read(u) };
  }

  // Not migrated: the global endpoint does not exist on this account.
  if (r.status === 404 && audienceId()) {
    const a = await fetch(`https://api.resend.com/audiences/${audienceId()}/contacts`, {
      method: 'POST', headers, body: JSON.stringify({ email, unsubscribed: false }),
    });
    if (a.ok || a.status === 409) return { ok: true, model: 'audiences', action: a.ok ? 'created' : 'existed', properties: false };
    return { ok: false, model: 'audiences', step: 'post', status: a.status, body: await read(a) };
  }

  // Refused with properties: keep the reason, then store the contact without them.
  const firstBody = await read(r);
  const bare = await fetch('https://api.resend.com/contacts', {
    method: 'POST', headers, body: JSON.stringify({ email, unsubscribed: false }),
  });
  if (bare.ok || bare.status === 409) {
    return { ok: true, model: 'contacts', action: bare.ok ? 'created' : 'existed', properties: false,
             propertiesRefused: { status: r.status, body: firstBody } };
  }
  return { ok: false, model: 'contacts', step: 'post', status: r.status, body: firstBody,
           bareStatus: bare.status, bareBody: await read(bare) };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Copy is Management's, word for word, and it was written against a list of
// banned words and phrases held in the brief. Nothing in here is the room's to
// reword: a line that will not work gets flagged, never replaced.
function deliveryHtml(downloadLink) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">Twenty-four things that go wrong with a day, and what to do about each one.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:10px;padding:28px 26px;font-family:Georgia,'Times New Roman',serif;color:#1a2a3a;">
      <tr><td>
        <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Here is the workbook.</p>

        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr><td style="border:1.5px solid #0C447C;border-radius:26px;">
          <a href="${esc(downloadLink)}" style="display:inline-block;padding:12px 26px;color:#0C447C;font-size:15px;font-weight:700;text-decoration:none;">Download The VoiceFirstPlanner Workbook</a>
        </td></tr></table>

        <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">You do not have to use all of it. Find the one page that is today's problem and do that page. The rest is there when you want it.</p>

        <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">Everything in it works out loud in VoiceFirstPlanner, which is free forever with no card, and you can look around the whole thing before you make an account.</p>

        <p style="font-size:16px;line-height:1.5;margin:0 0 22px;"><a href="https://${SITE}" style="color:#0C447C;font-weight:700;text-decoration:none;">Take a look around first: ${SITE}</a></p>

        <p style="font-size:16px;line-height:1.5;margin:0 0 2px;">Dave Rees</p>
        <p style="font-size:16px;line-height:1.5;margin:0 0 24px;">Founder, VoiceFirstPlanner</p>

        <p style="font-size:13px;line-height:1.5;color:#4a5a6a;margin:0 0 14px;">You asked for the workbook at ${SITE}. If you would rather not hear from us again, reply to this email with the word unsubscribe.</p>

        <p style="font-size:12px;line-height:1.5;color:#6b7a89;margin:0;border-top:1px solid #DCE6F0;padding-top:12px;">VoiceFirstPlanner Limited &middot; <a href="https://${SITE}" style="color:#6b7a89;">${SITE}</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// THE DOWNLOAD, FOLDED IN (2 Sep 2026)
//
// This was api/workbook-download.js, its own file, exactly as briefed. Vercel's
// Hobby plan allows 12 serverless functions per deployment and api/ already
// held 11, so two new files made 13 and every deploy failed. Rather than drop a
// requirement or ask for a paid plan mid-walk, the two endpoints share one
// function and the briefed URL is preserved by a rewrite in vercel.json:
// /api/workbook-download still resolves, so the link inside every email sent is
// unchanged and will keep working forever.
//
// The two paths stay strictly separate in behaviour: POST captures, GET serves
// the one free file. Nothing about the entitlement separation changes.
// ---------------------------------------------------------------------------

const BUCKET = 'lifetime-library';
const OBJECT_KEY = 'workbook.pdf';
const SIGNED_URL_SECONDS = 60;

// One page for every failure. Plain, no blame, and it tells the reader exactly
// what to do next rather than leaving them at a dead end.
function expiredPage(res, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>That link has expired</title>
</head>
<body style="margin:0;background:#F0F5FB;font-family:Georgia,'Times New Roman',serif;color:#1a2a3a;">
  <div style="max-width:520px;margin:12vh auto;padding:28px 26px;background:#fff;border-radius:10px;">
    <h1 style="font-size:20px;color:#0C447C;margin:0 0 12px;">That link has expired</h1>
    <p style="font-size:16px;line-height:1.5;margin:0 0 18px;">Download links stay live for 30 days. Ask for the workbook again and a fresh link comes straight back.</p>
    <p style="font-size:16px;line-height:1.5;margin:0;"><a href="https://${SITE}/start" style="color:#0C447C;font-weight:700;">${SITE}/start</a></p>
  </div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(html);
}

async function handleDownload(req, res) {
  // No token, bad signature, wrong shape, expired: all the same answer.
  const raw = req.query?.t;
  const token = Array.isArray(raw) ? raw[0] : raw;
  const claim = token ? verifyToken(token) : null;
  if (!claim) return expiredPage(res);

  // The subject must be one of ours. A validly signed token for something else
  //: a library token for a real user id, say , does not open this file.
  if (!String(claim.uid || '').startsWith('wb:')) {
    console.warn('workbook-download: valid token, wrong subject scope');
    return expiredPage(res);
  }

  if (!admin) {
    console.error('workbook-download: no admin client');
    return expiredPage(res);
  }

  try {
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(OBJECT_KEY, SIGNED_URL_SECONDS);

    if (error || !data?.signedUrl) {
      console.error('workbook-download: signing failed:', error?.message);
      return expiredPage(res);
    }

    // Best effort, never blocking: note that this subject downloaded. The
    // subject hash is stored on the row at capture time, which is the only way
    // back to it: the address itself is not recoverable from the token.
    try {
      await admin.from('captures')
        .update({ last_download_at: new Date().toISOString() })
        .eq('subject_hash', claim.uid);
    } catch (e) {
      console.warn('workbook-download: last_download_at not updated:', e.message);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, data.signedUrl);
  } catch (e) {
    console.error('workbook-download failed:', e.message);
    return expiredPage(res);
  }
}


// ---------------------------------------------------------------------------
// THE DAILY QUOTE (4 Sep 2026): job=quote
//
// Sent once a morning to every confirmed account: one line, one link, one way
// out. Runs on a Vercel cron that hits /api/quote-daily, which vercel.json
// rewrites to /api/capture?job=quote: the same one-function-many-jobs pattern
// the download uses, because the Hobby plan caps deployments at twelve
// functions and api/ is at twelve.
//
// WHICH QUOTE: the app's footer picks QUOTES[dayOfYear % 365] on the local
// date. The email uses the identical rule on the NEW ZEALAND date, so the line
// in the morning email is the line in the app that day. The list below is a
// copy of the app's: it has to be, since a serverless function cannot read
// the inline script: and that is a drift risk named in the delivery.
//
// IDEMPOTENT: a row in quote_sends (user_id, sent_on) is written BEFORE each
// send. A second cron on the same day finds the row and skips. A failed send
// deletes its row so the next attempt that day can retry.
//
// OPT-OUT: a dedicated quote_optouts table keyed on user_id, NOT a column on
// entitlements. Entitlements has NOT NULL columns without defaults, so an
// upsert for a user with no row yet would have to invent a plan: and nothing
// this side of the paid path should ever write that table. One table, one
// column, zero risk to anyone's entitlement.
// ---------------------------------------------------------------------------
const QUOTES = [
  { t: "The key is not to prioritize what's on your schedule, but to schedule your priorities.", a: "Stephen R. Covey" },
  { t: "Either you run the day, or the day runs you.", a: "Jim Rohn" },
  { t: "Begin with the end in mind.", a: "Stephen R. Covey" },
  { t: "Motivation is what gets you started. Habit is what keeps you going.", a: "Jim Rohn" },
  { t: "An investment in knowledge pays the best interest.", a: "Benjamin Franklin" },
  { t: "The main thing is to keep the main thing the main thing.", a: "Stephen R. Covey" },
  { t: "We are what we repeatedly do. Excellence is not an act but a habit.", a: "Will Durant" },
  { t: "By failing to prepare, you are preparing to fail.", a: "Benjamin Franklin" },
  { t: "A goal without a plan is just a wish.", a: "Antoine de Saint-Exupéry" },
  { t: "Plans are nothing; planning is everything.", a: "Dwight D. Eisenhower" },
  { t: "Give me six hours to chop down a tree and I will spend the first four sharpening the axe.", a: "Abraham Lincoln" },
  { t: "It takes as much energy to wish as it does to plan.", a: "Eleanor Roosevelt" },
  { t: "Good fortune is what happens when opportunity meets with planning.", a: "Thomas Edison" },
  { t: "Before anything else, preparation is the key to success.", a: "Alexander Graham Bell" },
  { t: "A man who does not plan long ahead will find trouble at his door.", a: "Confucius" },
  { t: "Someone's sitting in the shade today because someone planted a tree a long time ago.", a: "Warren Buffett" },
  { t: "Plan your work for today and every day, then work your plan.", a: "Margaret Thatcher" },
  { t: "Success depends upon previous preparation, and without such preparation there is sure to be failure.", a: "Confucius" },
  { t: "Luck is what happens when preparation meets opportunity.", a: "Seneca" },
  { t: "The time to repair the roof is when the sun is shining.", a: "John F. Kennedy" },
  { t: "Every minute you spend in planning saves ten minutes in execution.", a: "Brian Tracy" },
  { t: "He who every morning plans the transactions of the day will hold a thread to lead him through a labyrinth.", a: "Victor Hugo" },
  { t: "Organizing is what you do before you do something, so that when you do it, it is not all mixed up.", a: "A. A. Milne" },
  { t: "Have a plan. Follow the plan, and you'll be surprised how successful you can be.", a: "Paul Bryant" },
  { t: "Unless commitment is made, there are only promises and hopes; but no plans.", a: "Peter Drucker" },
  { t: "Planning is bringing the future into the present so that you can do something about it now.", a: "Alan Lakein" },
  { t: "Failing to plan is planning to fail.", a: "Alan Lakein" },
  { t: "Make no little plans; they have no magic to stir men's blood.", a: "Daniel Burnham" },
  { t: "In preparing for battle I have always found that plans are useless, but planning is indispensable.", a: "Dwight D. Eisenhower" },
  { t: "A good plan today is better than a perfect plan tomorrow.", a: "George S. Patton" },
  { t: "Strategy without tactics is the slowest route to victory.", a: "Sun Tzu" },
  { t: "The more I practice, the luckier I get.", a: "Gary Player" },
  { t: "Well begun is half done.", a: "Aristotle" },
  { t: "Forewarned, forearmed; to be prepared is half the victory.", a: "Miguel de Cervantes" },
  { t: "Dig the well before you are thirsty.", a: "Chinese proverb" },
  { t: "Measure twice, cut once.", a: "Proverb" },
  { t: "Lost time is never found again.", a: "Benjamin Franklin" },
  { t: "Dost thou love life? Then do not squander time, for that is the stuff life is made of.", a: "Benjamin Franklin" },
  { t: "Time is the coin of your life. Only you can determine how it will be spent.", a: "Carl Sandburg" },
  { t: "It is not that we have a short time to live, but that we waste a lot of it.", a: "Seneca" },
  { t: "While we are postponing, life speeds by.", a: "Seneca" },
  { t: "Time discovers truth.", a: "Seneca" },
  { t: "Know the true value of time; snatch, seize, and enjoy every moment of it.", a: "Lord Chesterfield" },
  { t: "Ordinary people think merely of spending time. Great people think of using it.", a: "Arthur Schopenhauer" },
  { t: "The bad news is time flies. The good news is you're the pilot.", a: "Michael Altshuler" },
  { t: "How we spend our days is, of course, how we spend our lives.", a: "Annie Dillard" },
  { t: "Time is what we want most, but what we use worst.", a: "William Penn" },
  { t: "Better three hours too soon than a minute too late.", a: "William Shakespeare" },
  { t: "You may delay, but time will not.", a: "Benjamin Franklin" },
  { t: "Time and tide wait for no man.", a: "Geoffrey Chaucer" },
  { t: "Regret for wasted time is more wasted time.", a: "Mason Cooley" },
  { t: "The future is something which everyone reaches at the rate of sixty minutes an hour.", a: "C. S. Lewis" },
  { t: "Yesterday is gone. Tomorrow has not yet come. We have only today. Let us begin.", a: "Mother Teresa" },
  { t: "They always say time changes things, but you actually have to change them yourself.", a: "Andy Warhol" },
  { t: "Time you enjoy wasting is not wasted time.", a: "Marthe Troly-Curtin" },
  { t: "One today is worth two tomorrows.", a: "Benjamin Franklin" },
  { t: "Take care of the minutes and the hours will take care of themselves.", a: "Lord Chesterfield" },
  { t: "Work expands so as to fill the time available for its completion.", a: "C. Northcote Parkinson" },
  { t: "A man who dares to waste one hour of time has not discovered the value of life.", a: "Charles Darwin" },
  { t: "Each day provides its own gifts.", a: "Marcus Aurelius" },
  { t: "Nothing is a waste of time if you use the experience wisely.", a: "Auguste Rodin" },
  { t: "Time stays long enough for anyone who will use it.", a: "Leonardo da Vinci" },
  { t: "This time, like all times, is a very good one, if we but know what to do with it.", a: "Ralph Waldo Emerson" },
  { t: "The two most powerful warriors are patience and time.", a: "Leo Tolstoy" },
  { t: "What may be done at any time will be done at no time.", a: "Scottish proverb" },
  { t: "The best time to plant a tree was twenty years ago. The second best time is now.", a: "Chinese proverb" },
  { t: "Well done is better than well said.", a: "Benjamin Franklin" },
  { t: "Never leave that till tomorrow which you can do today.", a: "Benjamin Franklin" },
  { t: "The way to get started is to quit talking and begin doing.", a: "Walt Disney" },
  { t: "Action is the foundational key to all success.", a: "Pablo Picasso" },
  { t: "Do what you can, with what you have, where you are.", a: "Theodore Roosevelt" },
  { t: "You don't have to be great to start, but you have to start to be great.", a: "Zig Ziglar" },
  { t: "The journey of a thousand miles begins with a single step.", a: "Lao Tzu" },
  { t: "It always seems impossible until it's done.", a: "Nelson Mandela" },
  { t: "Knowing is not enough; we must apply. Willing is not enough; we must do.", a: "Johann Wolfgang von Goethe" },
  { t: "What is not started today is never finished tomorrow.", a: "Johann Wolfgang von Goethe" },
  { t: "Whatever you can do, or dream you can, begin it. Boldness has genius, power and magic in it.", a: "Johann Wolfgang von Goethe" },
  { t: "Only put off until tomorrow what you are willing to die having left undone.", a: "Pablo Picasso" },
  { t: "How wonderful it is that nobody need wait a single moment before starting to improve the world.", a: "Anne Frank" },
  { t: "Amateurs sit and wait for inspiration; the rest of us just get up and go to work.", a: "Stephen King" },
  { t: "Procrastination is the thief of time.", a: "Edward Young" },
  { t: "You cannot escape the responsibility of tomorrow by evading it today.", a: "Abraham Lincoln" },
  { t: "The secret of getting ahead is getting started.", a: "Mark Twain" },
  { t: "Inspiration exists, but it has to find you working.", a: "Pablo Picasso" },
  { t: "Do the hard jobs first. The easy jobs will take care of themselves.", a: "Dale Carnegie" },
  { t: "Nothing will work unless you do.", a: "Maya Angelou" },
  { t: "Small deeds done are better than great deeds planned.", a: "Peter Marshall" },
  { t: "Even if you're on the right track, you'll get run over if you just sit there.", a: "Will Rogers" },
  { t: "The best way out is always through.", a: "Robert Frost" },
  { t: "If it is your job to eat a frog, it's best to do it first thing in the morning.", a: "Mark Twain" },
  { t: "Action may not always bring happiness, but there is no happiness without action.", a: "Benjamin Disraeli" },
  { t: "Just do it, and the confidence will follow.", a: "Carrie Fisher" },
  { t: "An ounce of action is worth a ton of theory.", a: "Ralph Waldo Emerson" },
  { t: "What you do speaks so loudly that I cannot hear what you say.", a: "Ralph Waldo Emerson" },
  { t: "Talk doesn't cook rice.", a: "Chinese proverb" },
  { t: "When there is a hill to climb, don't think that waiting will make it smaller.", a: "H. Jackson Brown Jr." },
  { t: "To think too long about doing a thing often becomes its undoing.", a: "Eva Young" },
  { t: "Doing the best at this moment puts you in the best place for the next moment.", a: "Oprah Winfrey" },
  { t: "A year from now you may wish you had started today.", a: "Karen Lamb" },
  { t: "There are seven days in the week, and someday isn't one of them.", a: "Proverb" },
  { t: "You miss one hundred percent of the shots you don't take.", a: "Wayne Gretzky" },
  { t: "Begin — to begin is half the work. Let half still remain; again begin this, and thou wilt have finished.", a: "Ausonius" },
  { t: "Take the first step in faith. You don't have to see the whole staircase, just take the first step.", a: "Martin Luther King Jr." },
  { t: "He who hesitates is lost.", a: "Proverb" },
  { t: "If you don't know where you are going, you'll end up someplace else.", a: "Yogi Berra" },
  { t: "Our goals can only be reached through a vehicle of a plan, in which we must fervently believe.", a: "Pablo Picasso" },
  { t: "Setting goals is the first step in turning the invisible into the visible.", a: "Tony Robbins" },
  { t: "A goal properly set is halfway reached.", a: "Zig Ziglar" },
  { t: "What you get by achieving your goals is not as important as what you become by achieving them.", a: "Zig Ziglar" },
  { t: "Arriving at one goal is the starting point to another.", a: "John Dewey" },
  { t: "The greater danger for most of us lies not in setting our aim too high and falling short, but in setting our aim too low and achieving our mark.", a: "Michelangelo" },
  { t: "Efforts and courage are not enough without purpose and direction.", a: "John F. Kennedy" },
  { t: "Give me a stock clerk with a goal and I'll give you a man who will make history.", a: "J. C. Penney" },
  { t: "If you aim at nothing, you will hit it every time.", a: "Zig Ziglar" },
  { t: "People with goals succeed because they know where they're going.", a: "Earl Nightingale" },
  { t: "A man without a goal is like a ship without a rudder.", a: "Thomas Carlyle" },
  { t: "The purpose of life is a life of purpose.", a: "Robert Byrne" },
  { t: "Obstacles are those frightful things you see when you take your eyes off your goal.", a: "Henry Ford" },
  { t: "If you want to live a happy life, tie it to a goal, not to people or things.", a: "Albert Einstein" },
  { t: "The tragedy of life doesn't lie in not reaching your goal. The tragedy lies in having no goal to reach.", a: "Benjamin E. Mays" },
  { t: "Goals are dreams with deadlines.", a: "Diana Scharf" },
  { t: "You are never too old to set another goal or to dream a new dream.", a: "C. S. Lewis" },
  { t: "Know thyself.", a: "Socrates" },
  { t: "The unexamined life is not worth living.", a: "Socrates" },
  { t: "First say to yourself what you would be; and then do what you have to do.", a: "Epictetus" },
  { t: "Man is a goal-seeking animal. His life only has meaning if he is reaching out and striving for his goals.", a: "Aristotle" },
  { t: "Great minds have purposes, others have wishes.", a: "Washington Irving" },
  { t: "When it is obvious that the goals cannot be reached, don't adjust the goals, adjust the action steps.", a: "Confucius" },
  { t: "He who has a why to live can bear almost any how.", a: "Friedrich Nietzsche" },
  { t: "Life can be pulled by goals just as surely as it can be pushed by drives.", a: "Viktor Frankl" },
  { t: "What you seek is seeking you.", a: "Rumi" },
  { t: "Habit is a cable; we weave a thread of it each day, and at last we cannot break it.", a: "Horace Mann" },
  { t: "Habits change into character.", a: "Ovid" },
  { t: "Discipline is the bridge between goals and accomplishment.", a: "Jim Rohn" },
  { t: "We first make our habits, and then our habits make us.", a: "John Dryden" },
  { t: "Success is the sum of small efforts, repeated day in and day out.", a: "Robert Collier" },
  { t: "Small daily improvements over time lead to stunning results.", a: "Robin Sharma" },
  { t: "The chains of habit are too weak to be felt until they are too strong to be broken.", a: "Samuel Johnson" },
  { t: "Good habits formed at youth make all the difference.", a: "Aristotle" },
  { t: "Motivation gets you going, but discipline keeps you growing.", a: "John C. Maxwell" },
  { t: "Winners make a habit of manufacturing their own positive expectations in advance of the event.", a: "Brian Tracy" },
  { t: "Your net worth to the world is usually determined by what remains after your bad habits are subtracted from your good ones.", a: "Benjamin Franklin" },
  { t: "The secret of your future is hidden in your daily routine.", a: "Mike Murdock" },
  { t: "Champions keep playing until they get it right.", a: "Billie Jean King" },
  { t: "It's not what we do once in a while that shapes our lives. It's what we do consistently.", a: "Tony Robbins" },
  { t: "Excellence is an art won by training and habituation.", a: "Will Durant" },
  { t: "Self-discipline is the ability to make yourself do what you should do, when you should do it, whether you feel like it or not.", a: "Elbert Hubbard" },
  { t: "First we form habits, then they form us. Conquer your bad habits or they will conquer you.", a: "Rob Gilbert" },
  { t: "A nail is driven out by another nail; habit is overcome by habit.", a: "Desiderius Erasmus" },
  { t: "Nothing is stronger than habit.", a: "Ovid" },
  { t: "Perseverance is not a long race; it is many short races one after the other.", a: "Walter Elliot" },
  { t: "Great things are done by a series of small things brought together.", a: "Vincent van Gogh" },
  { t: "The man who moves a mountain begins by carrying away small stones.", a: "Confucius" },
  { t: "It does not matter how slowly you go as long as you do not stop.", a: "Confucius" },
  { t: "Little strokes fell great oaks.", a: "Benjamin Franklin" },
  { t: "Drop by drop is the water pot filled.", a: "The Dhammapada" },
  { t: "Rivers know this: there is no hurry. We shall get there some day.", a: "A. A. Milne" },
  { t: "Continuous effort — not strength or intelligence — is the key to unlocking our potential.", a: "Winston Churchill" },
  { t: "Practice isn't the thing you do once you're good. It's the thing you do that makes you good.", a: "Malcolm Gladwell" },
  { t: "Repetition is the mother of learning, the father of action.", a: "Zig Ziglar" },
  { t: "Sow a thought, and you reap an act; sow an act, and you reap a habit; sow a habit, and you reap a character.", a: "Samuel Smiles" },
  { t: "Waste no more time arguing about what a good man should be. Be one.", a: "Marcus Aurelius" },
  { t: "The happiness of your life depends upon the quality of your thoughts.", a: "Marcus Aurelius" },
  { t: "Very little is needed to make a happy life; it is all within yourself, in your way of thinking.", a: "Marcus Aurelius" },
  { t: "If it is not right do not do it; if it is not true do not say it.", a: "Marcus Aurelius" },
  { t: "Dwell on the beauty of life. Watch the stars, and see yourself running with them.", a: "Marcus Aurelius" },
  { t: "When you arise in the morning, think of what a precious privilege it is to be alive.", a: "Marcus Aurelius" },
  { t: "The soul becomes dyed with the color of its thoughts.", a: "Marcus Aurelius" },
  { t: "Character is destiny.", a: "Heraclitus" },
  { t: "No man is free who is not master of himself.", a: "Epictetus" },
  { t: "Wealth consists not in having great possessions, but in having few wants.", a: "Epictetus" },
  { t: "It's not what happens to you, but how you react to it that matters.", a: "Epictetus" },
  { t: "Circumstances don't make the man, they only reveal him to himself.", a: "Epictetus" },
  { t: "Try not to become a man of success, but rather try to become a man of value.", a: "Albert Einstein" },
  { t: "Knowing yourself is the beginning of all wisdom.", a: "Aristotle" },
  { t: "Happiness depends upon ourselves.", a: "Aristotle" },
  { t: "Honesty is the first chapter in the book of wisdom.", a: "Thomas Jefferson" },
  { t: "To thine own self be true.", a: "William Shakespeare" },
  { t: "What lies behind us and what lies before us are tiny matters compared to what lies within us.", a: "Ralph Waldo Emerson" },
  { t: "The only person you are destined to become is the person you decide to be.", a: "Ralph Waldo Emerson" },
  { t: "To be yourself in a world that is constantly trying to make you something else is the greatest accomplishment.", a: "Ralph Waldo Emerson" },
  { t: "Nothing can bring you peace but yourself.", a: "Ralph Waldo Emerson" },
  { t: "Character is like a tree and reputation like a shadow. The shadow is what we think of it; the tree is the real thing.", a: "Abraham Lincoln" },
  { t: "Nearly all men can stand adversity, but if you want to test a man's character, give him power.", a: "Abraham Lincoln" },
  { t: "Be sure you put your feet in the right place, then stand firm.", a: "Abraham Lincoln" },
  { t: "It is better to deserve honors and not have them than to have them and not deserve them.", a: "Mark Twain" },
  { t: "Always do right. This will gratify some people and astonish the rest.", a: "Mark Twain" },
  { t: "Kindness is the language which the deaf can hear and the blind can see.", a: "Mark Twain" },
  { t: "Live your beliefs and you can turn the world around.", a: "Henry David Thoreau" },
  { t: "What you are will show in what you do.", a: "Thomas Edison" },
  { t: "The time is always right to do what is right.", a: "Martin Luther King Jr." },
  { t: "Real integrity is doing the right thing, knowing that nobody's going to know whether you did it or not.", a: "Oprah Winfrey" },
  { t: "Values are like fingerprints. Nobody's are the same, but you leave them all over everything you do.", a: "Elvis Presley" },
  { t: "It is easier to fight for one's principles than to live up to them.", a: "Alfred Adler" },
  { t: "He that is good for making excuses is seldom good for anything else.", a: "Benjamin Franklin" },
  { t: "Watch your thoughts, they become your words; watch your words, they become your actions.", a: "Lao Tzu" },
  { t: "When you know your values, making decisions becomes easier.", a: "Roy E. Disney" },
  { t: "The successful warrior is the average man, with laser-like focus.", a: "Bruce Lee" },
  { t: "Concentrate all your thoughts upon the work in hand. The sun's rays do not burn until brought to a focus.", a: "Alexander Graham Bell" },
  { t: "You can do two things at once, but you can't focus effectively on two things at once.", a: "Gary Keller" },
  { t: "Most of us spend too much time on what is urgent and not enough time on what is important.", a: "Stephen R. Covey" },
  { t: "Things which matter most must never be at the mercy of things which matter least.", a: "Johann Wolfgang von Goethe" },
  { t: "If you chase two rabbits, you will not catch either one.", a: "Russian proverb" },
  { t: "The essence of strategy is choosing what not to do.", a: "Michael Porter" },
  { t: "It is not enough to be busy; so are the ants. The question is: what are we busy about?", a: "Henry David Thoreau" },
  { t: "Our life is frittered away by detail. Simplify, simplify.", a: "Henry David Thoreau" },
  { t: "Beware the barrenness of a busy life.", a: "Socrates" },
  { t: "Nothing is less productive than to make more efficient what should not be done at all.", a: "Peter Drucker" },
  { t: "Efficiency is doing things right; effectiveness is doing the right things.", a: "Peter Drucker" },
  { t: "There is nothing so useless as doing efficiently that which should not be done at all.", a: "Peter Drucker" },
  { t: "What gets measured gets managed.", a: "Peter Drucker" },
  { t: "The shorter way to do many things is to do only one thing at a time.", a: "Wolfgang Amadeus Mozart" },
  { t: "One reason so few of us achieve what we truly want is that we never direct our focus; we never concentrate our power.", a: "Tony Robbins" },
  { t: "Simplicity is the ultimate sophistication.", a: "Leonardo da Vinci" },
  { t: "Besides the noble art of getting things done, there is the noble art of leaving things undone.", a: "Lin Yutang" },
  { t: "The ability to simplify means to eliminate the unnecessary so that the necessary may speak.", a: "Hans Hofmann" },
  { t: "Instead of focusing on how much you can accomplish, focus on how much you can absolutely love what you're doing.", a: "Leo Babauta" },
  { t: "The sculptor produces the beautiful statue by chipping away such parts of the marble block as are not needed.", a: "Elbert Hubbard" },
  { t: "Absorb what is useful, discard what is not, add what is uniquely your own.", a: "Bruce Lee" },
  { t: "You've got to think about big things while you're doing small things, so that all the small things go in the right direction.", a: "Alvin Toffler" },
  { t: "Where your attention goes, your time goes.", a: "Idowu Koyenikan" },
  { t: "Until we can manage time, we can manage nothing else.", a: "Peter Drucker" },
  { t: "A little simplification would be the first step toward rational living.", a: "Eleanor Roosevelt" },
  { t: "Out of clutter, find simplicity.", a: "Albert Einstein" },
  { t: "Life can only be understood backwards; but it must be lived forwards.", a: "Søren Kierkegaard" },
  { t: "Without reflection, we go blindly on our way.", a: "Margaret J. Wheatley" },
  { t: "Follow effective action with quiet reflection. From the quiet reflection will come even more effective action.", a: "Peter Drucker" },
  { t: "By three methods we may learn wisdom: first, by reflection, which is noblest.", a: "Confucius" },
  { t: "Your visions will become clear only when you can look into your own heart.", a: "Carl Jung" },
  { t: "Knowing others is intelligence; knowing yourself is true wisdom.", a: "Lao Tzu" },
  { t: "There are three things extremely hard: steel, a diamond, and to know one's self.", a: "Benjamin Franklin" },
  { t: "We do not learn from experience. We learn from reflecting on experience.", a: "John Dewey" },
  { t: "Everything that irritates us about others can lead us to an understanding of ourselves.", a: "Carl Jung" },
  { t: "Study the past if you would define the future.", a: "Confucius" },
  { t: "The real voyage of discovery consists not in seeking new landscapes, but in having new eyes.", a: "Marcel Proust" },
  { t: "Judge each day not by the harvest you reap but by the seeds you plant.", a: "Robert Louis Stevenson" },
  { t: "Turn your wounds into wisdom.", a: "Oprah Winfrey" },
  { t: "In three words I can sum up everything I've learned about life: it goes on.", a: "Robert Frost" },
  { t: "The only true wisdom is in knowing you know nothing.", a: "Socrates" },
  { t: "Growth is the only evidence of life.", a: "John Henry Newman" },
  { t: "Progress is impossible without change, and those who cannot change their minds cannot change anything.", a: "George Bernard Shaw" },
  { t: "Every man should be capable of being his own critic and his own encourager.", a: "Samuel Smiles" },
  { t: "What we achieve inwardly will change outer reality.", a: "Plutarch" },
  { t: "Sometimes you will never know the value of a moment until it becomes a memory.", a: "Dr. Seuss" },
  { t: "The past cannot be changed. The future is yet in your power.", a: "Mary Pickford" },
  { t: "Experience is not what happens to you; it's what you do with what happens to you.", a: "Aldous Huxley" },
  { t: "There is only one corner of the universe you can be certain of improving, and that's your own self.", a: "Aldous Huxley" },
  { t: "Never look back unless you are planning to go that way.", a: "Henry David Thoreau" },
  { t: "Be not afraid of growing slowly, be afraid only of standing still.", a: "Chinese proverb" },
  { t: "Learn from yesterday, live for today, hope for tomorrow.", a: "Albert Einstein" },
  { t: "Wisdom comes from experience. Experience is often a result of lack of wisdom.", a: "Terry Pratchett" },
  { t: "He who knows others is wise. He who knows himself is enlightened.", a: "Lao Tzu" },
  { t: "Fall seven times, stand up eight.", a: "Japanese proverb" },
  { t: "Our greatest glory is not in never falling, but in rising every time we fall.", a: "Confucius" },
  { t: "Energy and persistence conquer all things.", a: "Benjamin Franklin" },
  { t: "Perseverance and spirit have done wonders in all ages.", a: "George Washington" },
  { t: "Success is not final, failure is not fatal: it is the courage to continue that counts.", a: "Winston Churchill" },
  { t: "If you're going through hell, keep going.", a: "Winston Churchill" },
  { t: "Never, never, never give up.", a: "Winston Churchill" },
  { t: "Many of life's failures are people who did not realize how close they were to success when they gave up.", a: "Thomas Edison" },
  { t: "I have not failed. I've just found ten thousand ways that won't work.", a: "Thomas Edison" },
  { t: "Our greatest weakness lies in giving up. The most certain way to succeed is always to try just one more time.", a: "Thomas Edison" },
  { t: "It's hard to beat a person who never gives up.", a: "Babe Ruth" },
  { t: "Courage doesn't always roar. Sometimes courage is the quiet voice at the end of the day saying, I will try again tomorrow.", a: "Mary Anne Radmacher" },
  { t: "The gem cannot be polished without friction, nor man perfected without trials.", a: "Chinese proverb" },
  { t: "A river cuts through rock, not because of its power, but because of its persistence.", a: "Jim Watkins" },
  { t: "When you get into a tight place and everything goes against you, never give up then, for that is just the place and time that the tide will turn.", a: "Harriet Beecher Stowe" },
  { t: "Patience and perseverance have a magical effect before which difficulties disappear and obstacles vanish.", a: "John Quincy Adams" },
  { t: "The difference between a successful person and others is not a lack of strength, but rather a lack in will.", a: "Vince Lombardi" },
  { t: "It's not whether you get knocked down, it's whether you get up.", a: "Vince Lombardi" },
  { t: "Strength does not come from physical capacity. It comes from an indomitable will.", a: "Mahatma Gandhi" },
  { t: "You may encounter many defeats, but you must not be defeated.", a: "Maya Angelou" },
  { t: "Success seems to be largely a matter of hanging on after others have let go.", a: "William Feather" },
  { t: "Diamonds are nothing more than chunks of coal that stuck to their jobs.", a: "Malcolm Forbes" },
  { t: "Great works are performed not by strength but by perseverance.", a: "Samuel Johnson" },
  { t: "If you can't fly then run, if you can't run then walk, if you can't walk then crawl, but whatever you do you have to keep moving forward.", a: "Martin Luther King Jr." },
  { t: "All our dreams can come true, if we have the courage to pursue them.", a: "Walt Disney" },
  { t: "The future belongs to those who believe in the beauty of their dreams.", a: "Eleanor Roosevelt" },
  { t: "Go confidently in the direction of your dreams. Live the life you have imagined.", a: "Henry David Thoreau" },
  { t: "If one advances confidently in the direction of his dreams, he will meet with a success unexpected in common hours.", a: "Henry David Thoreau" },
  { t: "Twenty years from now you will be more disappointed by the things you didn't do than by the ones you did do.", a: "H. Jackson Brown Jr." },
  { t: "Life is either a daring adventure or nothing at all.", a: "Helen Keller" },
  { t: "The only impossible journey is the one you never begin.", a: "Tony Robbins" },
  { t: "Every great dream begins with a dreamer.", a: "Harriet Tubman" },
  { t: "The biggest adventure you can take is to live the life of your dreams.", a: "Oprah Winfrey" },
  { t: "Dream big and dare to fail.", a: "Norman Vaughan" },
  { t: "It's never too late to be what you might have been.", a: "George Eliot" },
  { t: "First, think. Second, believe. Third, dream. And finally, dare.", a: "Walt Disney" },
  { t: "A ship in harbour is safe, but that is not what ships are built for.", a: "John A. Shedd" },
  { t: "You cannot swim for new horizons until you have courage to lose sight of the shore.", a: "William Faulkner" },
  { t: "Only those who will risk going too far can possibly find out how far one can go.", a: "T. S. Eliot" },
  { t: "What would life be if we had no courage to attempt anything?", a: "Vincent van Gogh" },
  { t: "I dwell in possibility.", a: "Emily Dickinson" },
  { t: "Nothing happens unless first we dream.", a: "Carl Sandburg" },
  { t: "Throw your dreams into space like a kite, and you do not know what it will bring back.", a: "Anaïs Nin" },
  { t: "Quality is not an act, it is a habit.", a: "Aristotle" },
  { t: "Pleasure in the job puts perfection in the work.", a: "Aristotle" },
  { t: "Choose a job you love, and you will never have to work a day in your life.", a: "Confucius" },
  { t: "The only way to do great work is to love what you do.", a: "Steve Jobs" },
  { t: "Quality means doing it right when no one is looking.", a: "Henry Ford" },
  { t: "Whether you think you can, or you think you can't — you're right.", a: "Henry Ford" },
  { t: "Coming together is a beginning; keeping together is progress; working together is success.", a: "Henry Ford" },
  { t: "There is no substitute for hard work.", a: "Thomas Edison" },
  { t: "Opportunity is missed by most people because it is dressed in overalls and looks like work.", a: "Thomas Edison" },
  { t: "Genius is one percent inspiration and ninety-nine percent perspiration.", a: "Thomas Edison" },
  { t: "If a man is called to be a street sweeper, he should sweep streets even as Michelangelo painted.", a: "Martin Luther King Jr." },
  { t: "Far and away the best prize that life offers is the chance to work hard at work worth doing.", a: "Theodore Roosevelt" },
  { t: "A craftsman never blames his tools.", a: "Proverb" },
  { t: "Measure your success by the quality of your effort.", a: "John Wooden" },
  { t: "Don't mistake activity for achievement.", a: "John Wooden" },
  { t: "If you don't have time to do it right, when will you have time to do it over?", a: "John Wooden" },
  { t: "The harder I work, the luckier I get.", a: "Samuel Goldwyn" },
  { t: "Nothing ever comes to one, that is worth having, except as a result of hard work.", a: "Booker T. Washington" },
  { t: "Working hard for something we don't care about is called stress; working hard for something we love is called passion.", a: "Simon Sinek" },
  { t: "Do your work with your whole heart, and you will succeed — there's so little competition.", a: "Elbert Hubbard" },
  { t: "The reward of a thing well done is having done it.", a: "Ralph Waldo Emerson" },
  { t: "Craftsmanship names an enduring, basic human impulse: the desire to do a job well for its own sake.", a: "Richard Sennett" },
  { t: "He who works with his hands is a labourer. He who works with his hands and his head is a craftsman.", a: "Francis of Assisi" },
  { t: "Change is the law of life. And those who look only to the past or present are certain to miss the future.", a: "John F. Kennedy" },
  { t: "It is not the strongest of the species that survives, but the one most responsive to change.", a: "Charles Darwin" },
  { t: "You must be the change you wish to see in the world.", a: "Mahatma Gandhi" },
  { t: "The measure of intelligence is the ability to change.", a: "Albert Einstein" },
  { t: "In the middle of difficulty lies opportunity.", a: "Albert Einstein" },
  { t: "When we are no longer able to change a situation, we are challenged to change ourselves.", a: "Viktor Frankl" },
  { t: "Everything can be taken from a man but one thing: to choose one's attitude in any given set of circumstances.", a: "Viktor Frankl" },
  { t: "Courage is resistance to fear, mastery of fear — not absence of fear.", a: "Mark Twain" },
  { t: "You gain strength, courage, and confidence by every experience in which you really stop to look fear in the face.", a: "Eleanor Roosevelt" },
  { t: "Do one thing every day that scares you.", a: "Eleanor Roosevelt" },
  { t: "No one can make you feel inferior without your consent.", a: "Eleanor Roosevelt" },
  { t: "Life shrinks or expands in proportion to one's courage.", a: "Anaïs Nin" },
  { t: "And the day came when the risk to remain tight in a bud was more painful than the risk it took to blossom.", a: "Anaïs Nin" },
  { t: "He who is not courageous enough to take risks will accomplish nothing in life.", a: "Muhammad Ali" },
  { t: "Don't count the days, make the days count.", a: "Muhammad Ali" },
  { t: "If you always do what you've always done, you'll always get what you've always got.", a: "Henry Ford" },
  { t: "Not everything that is faced can be changed, but nothing can be changed until it is faced.", a: "James Baldwin" },
  { t: "When one door closes, another opens.", a: "Alexander Graham Bell" },
  { t: "The secret of change is to focus all of your energy not on fighting the old, but on building the new.", a: "Dan Millman" },
  { t: "Live as if you were to die tomorrow. Learn as if you were to live forever.", a: "Mahatma Gandhi" },
  { t: "Tell me and I forget. Teach me and I remember. Involve me and I learn.", a: "Benjamin Franklin" },
  { t: "Being ignorant is not so much a shame, as being unwilling to learn.", a: "Benjamin Franklin" },
  { t: "Anyone who stops learning is old, whether at twenty or eighty.", a: "Henry Ford" },
  { t: "Wisdom is not a product of schooling but of the lifelong attempt to acquire it.", a: "Albert Einstein" },
  { t: "The more that you read, the more things you will know. The more that you learn, the more places you'll go.", a: "Dr. Seuss" },
  { t: "Education is the most powerful weapon which you can use to change the world.", a: "Nelson Mandela" },
  { t: "I am still learning.", a: "Michelangelo" },
  { t: "Learning never exhausts the mind.", a: "Leonardo da Vinci" },
  { t: "In every walk with nature one receives far more than he seeks.", a: "John Muir" },
  { t: "Gratitude is not only the greatest of virtues, but the parent of all the others.", a: "Cicero" },
  { t: "He is a wise man who does not grieve for the things which he has not, but rejoices for those which he has.", a: "Epictetus" },
  { t: "Reflect upon your present blessings, of which every man has plenty.", a: "Charles Dickens" },
  { t: "Enjoy the little things, for one day you may look back and realize they were the big things.", a: "Robert Brault" },
  { t: "Acknowledging the good that you already have in your life is the foundation for all abundance.", a: "Eckhart Tolle" },
  { t: "When you arise in the morning give thanks for the food and for the joy of living.", a: "Tecumseh" },
  { t: "Happiness is not something ready made. It comes from your own actions.", a: "Dalai Lama" },
  { t: "The best and most beautiful things in the world cannot be seen or even touched — they must be felt with the heart.", a: "Helen Keller" },
  { t: "Contentment is natural wealth; luxury is artificial poverty.", a: "Socrates" },
  { t: "He who is contented is rich.", a: "Lao Tzu" },
  { t: "Nature does not hurry, yet everything is accomplished.", a: "Lao Tzu" },
  { t: "The wise man will make more opportunities than he finds.", a: "Francis Bacon" },
  { t: "Knowledge is power.", a: "Francis Bacon" },
  { t: "Every day may not be good, but there's something good in every day.", a: "Alice Morse Earle" },
  { t: "Write it on your heart that every day is the best day in the year.", a: "Ralph Waldo Emerson" },
  { t: "Finish each day and be done with it. You have done what you could.", a: "Ralph Waldo Emerson" },
  { t: "The days are long, but the years are short.", a: "Gretchen Rubin" },
  { t: "Take rest; a field that has rested gives a bountiful crop.", a: "Ovid" },
];
const QUOTE_APP_URL = 'https://app.voicefirstdayplanner.com';
const QUOTE_SEND_GAP_MS = 120;          // gentle on Resend's per-second limit

// Today's date parts in Pacific/Auckland, DST-correct, no library.
function nzDateParts(now) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {}; for (const { type, value } of f.formatToParts(now || new Date())) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, key: `${p.year}-${p.month}-${p.day}` };
}
function quoteForNzDate(parts) {
  // Same arithmetic as the app footer, on the NZ calendar date.
  const start = Date.UTC(parts.y, 0, 0);
  const dayOfYear = Math.round((Date.UTC(parts.y, parts.m - 1, parts.d) - start) / 86400000);
  const idx = dayOfYear % QUOTES.length;
  return { idx, ...QUOTES[idx] };
}

// Copy is Management's, verbatim.
function quoteEmailHtml(q, unsubLink) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0F5FB;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(q.t)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F5FB;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:10px;padding:30px 26px;font-family:Georgia,'Times New Roman',serif;color:#1a2a3a;">
      <tr><td>
        <p style="font-size:19px;line-height:1.5;margin:0 0 6px;font-style:italic;">&ldquo;${esc(q.t)}&rdquo;</p>
        <p style="font-size:14px;line-height:1.5;margin:0 0 26px;color:#4a5a6a;">&mdash; ${esc(q.a)}</p>

        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 26px;"><tr><td style="border:1.5px solid #0C447C;border-radius:26px;">
          <a href="${QUOTE_APP_URL}" style="display:inline-block;padding:12px 26px;color:#0C447C;font-size:15px;font-weight:700;text-decoration:none;">Plan your day</a>
        </td></tr></table>

        <p style="font-size:13px;line-height:1.5;color:#4a5a6a;margin:0 0 14px;">You get this because you have a VoiceFirstPlanner account. <a href="${esc(unsubLink)}" style="color:#4a5a6a;">Stop the morning quote</a> and you will not hear from us this way again.</p>

        <p style="font-size:12px;line-height:1.5;color:#6b7a89;margin:0;border-top:1px solid #DCE6F0;padding-top:12px;">VoiceFirstPlanner Limited &middot; <a href="https://${SITE}" style="color:#6b7a89;">${SITE}</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function cronAuthorised(req) {
  const want = process.env.CRON_SECRET || '';
  if (!want) return false;                                  // no secret configured: refuse, never run open
  const got = String(req.headers['authorization'] || '');
  return got === `Bearer ${want}`;
}

async function listConfirmedUsers() {
  const out = [];
  for (let page = 1; page <= 50; page++) {                   // 50k users is far beyond today
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users || [];
    users.forEach(u => { if (u.email && u.email_confirmed_at) out.push({ id: u.id, email: u.email, name: u.user_metadata?.first_name || u.user_metadata?.name || '' }); });
    if (users.length < 1000) break;
  }
  return out;
}

async function runDailyQuote(req, res) {
  if (!cronAuthorised(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!admin) return res.status(500).json({ error: 'server_misconfigured' });

  const nz = nzDateParts(new Date());
  const q = quoteForNzDate(nz);
  const summary = { date_nz: nz.key, quote_index: q.idx, author: q.a, eligible: 0, sent: 0,
                    skipped_already_sent: 0, skipped_opted_out: 0, failed: 0, dry_run: !!req.query?.dry };

  let users;
  try { users = await listConfirmedUsers(); }
  catch (e) { console.error('quote: listUsers failed:', e.message); return res.status(502).json({ ...summary, error: 'list_users_failed' }); }

  const { data: outs } = await admin.from('quote_optouts').select('user_id');
  const optedOut = new Set((outs || []).map(r => r.user_id));

  for (const u of users) {
    if (optedOut.has(u.id)) { summary.skipped_opted_out++; continue; }
    summary.eligible++;
    if (summary.dry_run) continue;

    // Claim today for this user BEFORE sending. Unique (user_id, sent_on) means
    // a second cron finds the row and moves on.
    const { error: claimErr } = await admin.from('quote_sends').insert({ user_id: u.id, sent_on: nz.key });
    if (claimErr) {
      if (String(claimErr.code) === '23505') { summary.skipped_already_sent++; continue; }
      console.warn('quote: claim failed for', u.id, claimErr.message); summary.failed++; continue;
    }

    const unsub = `${QUOTE_APP_URL}/api/quote-daily?unsub=${encodeURIComponent(mintToken('dq:' + u.id, 400))}`;
    let ok = false;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM, to: [u.email],
          subject: 'Your quote for today',
          html: quoteEmailHtml(q, unsub),
          headers: { 'List-Unsubscribe': `<${unsub}>` },
        }),
      });
      ok = r.ok;
      if (!ok) console.warn('quote: send failed', u.id, r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.warn('quote: send threw', u.id, e.message); }

    if (ok) summary.sent++;
    else {
      summary.failed++;
      // Release the claim so the next attempt today can retry this user.
      await admin.from('quote_sends').delete().eq('user_id', u.id).eq('sent_on', nz.key);
    }
    await new Promise(r => setTimeout(r, QUOTE_SEND_GAP_MS));
  }

  console.log('quote-daily:', JSON.stringify(summary));
  return res.status(200).json(summary);
}

// The one-click way out. Token subject is 'dq:<uid>', so a library token
// cannot be used here and this token cannot be used there.
async function quoteUnsubscribe(req, res) {
  const raw = req.query?.unsub; const token = Array.isArray(raw) ? raw[0] : raw;
  const claim = token ? verifyToken(token) : null;
  const uid = claim && String(claim.uid || '').startsWith('dq:') ? claim.uid.slice(3) : null;
  const page = (title, body) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#F0F5FB;font-family:Georgia,'Times New Roman',serif;color:#1a2a3a;"><div style="max-width:520px;margin:12vh auto;padding:28px 26px;background:#fff;border-radius:10px;">
<h1 style="font-size:20px;color:#0C447C;margin:0 0 12px;">${esc(title)}</h1><p style="font-size:16px;line-height:1.5;margin:0;">${body}</p></div></body></html>`);
  };
  if (!uid || !admin) return page('That link has expired', 'Open the app and use Settings to change what we send you.');
  const { error } = await admin.from('quote_optouts').upsert({ user_id: uid, at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) { console.warn('quote: optout failed', uid, error.message); return page('Something went wrong', 'Please try the link again in a moment.'); }
  return page('Done', 'The morning quote has stopped. Your planner is unchanged.');
}

// ---------------------------------------------------------------------------
// CAPTURE STATS (4 Sep 2026): job=stats. Read-only, admin-only, the numbers
// that say whether rung one is working. /api/capture-stats rewrites here.
// ---------------------------------------------------------------------------
async function captureStats(req, res) {
  if (!cronAuthorised(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!admin) return res.status(500).json({ error: 'server_misconfigured' });
  const { data, error } = await admin.from('captures').select('source, captured_at, last_download_at');
  if (error) return res.status(502).json({ error: 'query_failed' });
  const rows = data || [];
  const now = Date.now(), d7 = now - 7 * 86400e3, d30 = now - 30 * 86400e3;
  const bySource = {}, byDay = {};
  let last7 = 0, last30 = 0, downloaded = 0;
  for (const r of rows) {
    const t = Date.parse(r.captured_at || 0);
    if (t >= d7) last7++;
    if (t >= d30) { last30++; const k = (r.captured_at || '').slice(0, 10); byDay[k] = (byDay[k] || 0) + 1; }
    bySource[r.source || 'start'] = (bySource[r.source || 'start'] || 0) + 1;
    if (r.last_download_at) downloaded++;
  }
  return res.status(200).json({
    total: rows.length, last_7_days: last7, last_30_days: last30,
    downloaded_at_least_once: downloaded,
    download_rate: rows.length ? +(downloaded / rows.length).toFixed(3) : 0,
    by_source: bySource, by_day_last_30: byDay, generated_at: new Date().toISOString(),
  });
}

export default async function handler(req, res) {
  // CORS: the marketing site only. Nothing else may call this from a browser.
  const origin = req.headers.origin || '';
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    // A preflight from anywhere else gets no allow header, so the browser stops it.
    return res.status(origin === ALLOWED_ORIGIN ? 204 : 403).end();
  }
  // Jobs that share this function (Hobby plan: twelve functions, all used).
  // vercel.json rewrites /api/quote-daily and /api/capture-stats here with a
  // job= parameter; the rewrite preserves the original query string.
  const job = String((Array.isArray(req.query?.job) ? req.query.job[0] : req.query?.job) || '');
  if (req.method === 'GET' && job === 'quote') {
    return req.query?.unsub ? quoteUnsubscribe(req, res) : runDailyQuote(req, res);
  }
  if (req.method === 'GET' && job === 'stats') return captureStats(req, res);

  // GET is the workbook download (see the note above). POST is the capture.
  if (req.method === 'GET') return handleDownload(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'origin_not_allowed' });
  }

  try {
    const body = req.body || {};

    // Honeypot: a hidden field a person never sees and a bot fills in. Answer
    // 200 and do nothing at all, so the bot learns nothing from the response.
    const hp = body.website ?? body.company ?? body.hp ?? '';
    if (String(hp).trim() !== '') {
      console.log('capture honeypot tripped, ignored');
      return res.status(200).json({ ok: true });
    }

    const email = validEmail(body.email);
    if (!email) return res.status(400).json({ error: 'invalid_email' });

    const source = ALLOWED_SOURCES.includes(String(body.source || '').trim())
      ? String(body.source).trim() : 'start';

    const ip = clientIp(req);
    if (await rateLimited('ip:' + hashWithSecret(ip))) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    const capturedAt = new Date().toISOString();
    const subjectHash = subjectFor(email);

    // Our own record first. This is where rung one is measured, whatever Resend
    // holds: so a Resend outage still leaves us the address.
    if (admin) {
      const { error } = await admin.from('captures').upsert({
        email,
        source,
        captured_at: capturedAt,
        ip_hash: hashWithSecret(ip),
        subject_hash: subjectHash,
      }, { onConflict: 'email' });
      if (error) console.warn('capture row not written:', error.message);
    }

    const contact = await upsertContact(email, source, capturedAt);
    console.log('capture contact:', JSON.stringify(contact));

    // 30 days, matching the library tokens. The subject is the hash, never the
    // address, so the link leaks nothing if it is forwarded.
    const token = mintToken(subjectHash, 30);
    const link = `${APP_BASE}/api/workbook-download?t=${encodeURIComponent(token)}`;

    const send = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: 'Your workbook is ready',
        html: deliveryHtml(link),
        headers: { 'List-Unsubscribe': '<mailto:contact@voicefirstdayplanner.com?subject=unsubscribe>' },
      }),
    });

    if (!send.ok) {
      const detail = (await send.text()).slice(0, 300);
      console.error('capture send failed:', send.status, detail);
      return res.status(502).json({ error: 'Sorry, something went wrong sending that. Please try again.' });
    }

    if (!contact.ok) console.warn('capture contact not stored in Resend:', JSON.stringify(contact));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('capture failed:', e.message);
    return res.status(502).json({ error: 'Sorry, something went wrong sending that. Please try again.' });
  }
}
