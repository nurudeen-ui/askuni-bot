# Orbuni ⇄ AskUni bot — deployed, all four wizard steps written

**Sixth real test, 18 Sep 2026 (night): furthest yet — both fifth-test
fixes confirmed working, and one brand-new bug on step 01 itself.**
With the fifth fix's two bugs (the page-load hang and the double-click
race) now deployed, Nurudeen tried again. Render's logs show this
attempt is real progress, not another repeat: no hang, no double-click
crash. It navigated to the student list, found and clicked "ADD STUDENT
USER," and started actually typing into the real form — first name,
last name — before hitting a NEW, different error: `strict mode
violation: getByLabel('Email') resolved to 2 elements`. That means
AskUni's real "Add Student User" form has two different inputs that
Playwright's `getByLabel("Email")` can both match — one at
`id=":r2:"` (almost certainly some other control on the page that just
happens to also carry an accessible name of "Email"), and one at
`id="eMail"` with `placeholder="example@gmail.com"` — the real field.
Playwright refuses to guess between two matches and stopped there
rather than risk typing into the wrong one. Fixed by pointing the code
directly at the confirmed real id (`#eMail`) instead of the ambiguous
label — this isn't a guess, it's the exact id AskUni's own page
reported in the error. **This is the furthest any attempt has ever
gotten — past login, past the student list, into the actual new-student
form and typing real values — not yet re-tested since this fix.**

**Fifth real test, 18 Sep 2026 (night): confirmed real — logged in for
real, filled the wizard, and two genuine new bugs found.** With the
fourth fix live, Nurudeen tried again: the tab opened already on
AskUni's real login page, he logged in for real via AskUni's own
"Partner" flow, saw his real dashboard, came back and clicked "I'm
logged in — Continue." He reported "nothing happened" and later saw
Browserbase's live-view tab say "Debugging connection was closed."
Render's own logs show exactly what happened, and it is real
activity, not nothing: the bot connected to his live, logged-in
session and started filling the wizard. Two real bugs, both fixed:

1. **The page never finished loading by the definition the code was
   using.** The third fix (above) made the student-list navigation wait
   for `networkidle` — no network activity for half a second — but a
   real logged-in AskUni dashboard almost certainly has something
   always running in the background (a chat widget, analytics, a
   websocket), so it can be fully usable and still never go network-idle
   at all. The navigation waited the full 60 seconds and gave up. Fixed
   by dropping the `networkidle` wait entirely: the code now just
   confirms the HTML has arrived (`domcontentloaded`) and lets the very
   next line's button-click do what it already does automatically —
   keep retrying for up to 60 seconds until that specific button exists
   and is clickable. That auto-wait was always there; it just needed to
   be the thing actually relied on.
2. **Because the card gave no visible "working" state, a second click
   on Continue felt reasonable — and it silently launched a SECOND
   automation on the very same AskUni session while the first was still
   running.** The first one's failure correctly closed the browser
   session to clean up — but on a live AskUni session, closing it ends
   the whole remote browser, which is exactly what killed the second
   one mid-navigation and is what showed up as "Debugging connection was
   closed" in the live-view tab Nurudeen had open. Fixed two ways: the
   bot now refuses a second Continue call for a session that already has
   one running, and the Orbuni site itself swaps the card to a plain
   "Sending to AskUni… this can take a minute" state with no buttons at
   all the instant Continue is pressed, so there's nothing left to
   click twice.

**Not yet re-tested since these two fixes** — but this attempt is genuine
proof the bot is real and working end to end up to this point: it held
Nurudeen's real login, opened the real dashboard, and started filling in
the real wizard. The failure was a timing/double-click bug, not "the bot
doesn't exist."

**Fourth real test, 18 Sep 2026: the real explanation for "nothing
happens" — the login tab was opening completely blank the whole time.**
After the third fix went out, Nurudeen tried again and described (and
photographed) something confusing: clicking "Send to AskUni" opened a
tab, he came back, clicked "I'm logged in — Continue" and nothing
seemed to happen, and a second tab he opened showed Browserbase's
devtools view sitting on a literal blank "about:blank" page. The real,
simple explanation: a brand-new Browserbase session opens on a
completely blank page by default — this code never actually sent it
anywhere. Every "Send to AskUni" click all along has been opening an
empty tab with zero indication of what to do, and Nurudeen had
correctly guessed he needed to type in AskUni's own login URL by hand,
but had no way to know if he was even doing the right thing or looking
at the right browser. Fixed for real this time: `/submissions` (the
"Send to AskUni" click) now drives that same live session straight to
the real login page (`https://apply.askuni.com/login/`, confirmed for
real from Nurudeen's own message) before handing back the live view
link — so the tab that opens is already sitting on AskUni's actual
login form. **Not yet re-tested.**

**Third real test, 18 Sep 2026: past login for the first time — a new,
different failure, further into the flow than either bug before it.**
With both fixes above live, Nurudeen tried again — and for the first
time, the login itself worked and the flow actually got INTO the real
askuni.com wizard, further than any previous attempt. It then timed out
30 seconds into the very first click, "ADD STUDENT USER" on the student
list page. Real cause, read straight from Playwright's own error/call
log Nurudeen sent a photo of: the code navigated to that page with a
plain `page.goto(url)`, which only waits for the browser's "load" event
— not for whatever the page then fetches and renders client-side.
AskUni's list page has to load the real student list before it can show
its own "ADD STUDENT USER" button, so the click was trying to find a
button that might not have existed on the page yet, and 30 seconds
wasn't always long enough for a cold browser hitting a real remote site
for the first time after login. Fixed two ways: that navigation now
waits for `networkidle` (the page's own background loading to actually
finish) instead of just the browser's load event, and every action in
this flow now gets 60 seconds instead of 30 to find what it's looking
for. Also added: if ANY step in the whole wizard fails from now on, the
bot takes a real screenshot of whatever askuni.com was showing at that
exact moment and includes a link to it right in the error — so if this
happens again, or something else does, there's a picture of the real
page instead of another round of screenshotting Nurudeen's own screen.
This is a principled, evidence-based fix (this environment still can't
reach askuni.com directly to test it), but it's genuinely new territory
— the first two attempts never even got this far. **Not yet re-tested.**

**Second real test, 17 Sep 2026 (night): found and fixed a second real
bug — same error message, different cause.** After the first fix below
went live, Nurudeen clicked "Send to AskUni" again and got the exact
same "Edge Function returned a non-2xx status code" toast. That was
worrying on its face — looked like the fix hadn't worked — but Render's
own logs (now readable thanks to the logging the first fix added)
showed a completely different, very specific error this time:
`409 A context with this name already exists in the project`. Real
cause: this code always tried to create a Browserbase context (its
word for a saved AskUni login) under the same fixed name,
`"orbuni-askuni"`. The very first attempt, before `integration_settings`
even existed as a table, DID create that context in Browserbase — but
saving its id back to Supabase failed with a 404 that the code never
checked for and silently swallowed. So Browserbase ended up holding a
real context named `orbuni-askuni` that this service had no record of,
and every attempt since kept trying to create ANOTHER one under that
same name, which Browserbase correctly refuses (names must be unique
per project). Two real fixes: the context is no longer created with a
fixed name at all (a name was only ever cosmetic — the login is found
again by its id, which is what actually gets saved and reused), and
both places that save/read that id now throw a real, visible error
instead of silently doing nothing if the save fails — so a bug like
this can never hide behind a generic error again. **Not yet re-tested
against a real login** — that's the next click.

**First real test, 17 Sep 2026 (night): found and fixed a real bug.**
Nurudeen clicked the real "Send to AskUni" button for the first time
(Aisha Aman's application) and got "Edge Function returned a non-2xx
status code." Traced it through Supabase's logs to askuni-bot itself
returning a real 500 — and the actual cause was a genuine bug, not a
config problem: `bb.sessions.liveUrls.create(session.id)` was never a
real method on the Browserbase SDK (checked directly against their
current API docs). The correct call is `bb.sessions.debug(session.id)`,
which returns `{ debuggerFullscreenUrl, debuggerUrl, pages }` — fixed
now. Also created a database table this code depended on but that
never actually existed (`integration_settings`, where the reusable
login gets saved between restarts — checked directly, it was a genuine
404, not a permissions issue), and added real `console.log`/
`console.error` lines through every step of `/submissions`,
`/submissions/:id/continue`, and `/check-responses`, so if anything
else goes wrong on the next attempt, Render's logs will show exactly
where instead of only a generic error message reaching the browser.

**Status, 17 Sep 2026 (night):** this is now a real, running Render
service, not just a skeleton. `askuni-bot` is deployed at
`https://askuni-bot.onrender.com`, connected to Nurudeen's own Render +
Browserbase accounts. `SUPABASE_URL`, `ASKUNI_PORTAL_URL`,
`INTERNAL_SHARED_SECRET`, `BROWSERBASE_API_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` are all set — Nurudeen had already put the
service role key in earlier. A `GET /diagnostics?secret=...` self-check
(opened directly in his own browser, since this session's own network
can't reach the live URL) confirmed both `browserbase` and `supabase`
report `"ok"` — real cloud-browser access and real database access are
both working right now, live, not just in theory.

**All four wizard steps (01–04) are now written** (see `index.js`).
Nurudeen sent his screenshot walkthrough twice, and it turned up two
real bugs in step 04 that the first draft got wrong from working off a
written description alone rather than the pictures themselves: the
programme search box's placeholder doesn't contain the word "search"
at all (it's "Type Interested Program and Press Enter"), and
"Application submit!" is not the end of the flow — a separate "FINISH"
button has to be clicked afterward to actually complete the wizard and
land on the student's profile page. Both are fixed now.

**Step 02 (Student Information) is now written too.** Nurudeen's
second screenshot batch finally caught the wizard from the very start
and confirmed every field on this step: Passport Number, Birth Date,
Country of Birth, Country of Residence, Nationality, City of
Residence, Address, Mother Name, Father Name, Passport Date of Expire,
Passport Date of Issue, and a "Need Visa" toggle. Checking Orbuni's
real database again turned up a `student_details` table (one row per
student) that holds most of these — passport number, date of birth,
nationality, mother/father name, address, city, country, passport
expiry — so those now get filled in for real from the real record.

Three of AskUni's step-02 fields are still deliberately left blank,
same reasoning as Gender/Mobile Phone in step 01 — better blank than
wrong on a real student's real application:
- **Country of Birth** — Orbuni's schema has `place_of_birth`, but
  it was never confirmed to actually hold a country rather than a
  city/town, and it's a dropdown on AskUni's side anyway.
- **Country of Residence and Nationality** — both dropdowns, and
  whether AskUni's dropdown is a plain list (safe to auto-select) or a
  custom searchable box (which would silently fail) was never seen in
  a screenshot.
- **Passport Date of Issue and Need Visa** — no matching data exists
  anywhere in Orbuni's database yet for either one.

Step 03 (Documents) is still written as a best-effort inference from
the completed student's own "Essential Documents" page (Passport /
Diploma / Transcript / Profile Picture) rather than a screenshot of
step 03 itself — flag it as the first thing to check if it throws.

**Nothing is genuinely blocked anymore.** The bot can attempt a real,
end-to-end submission right now.

**`/submissions` and `/submissions/:sessionId/continue` now also work
as plain browser links, not just as calls a portal button would make.**
The real "Send to AskUni" button in the Orbuni portal itself doesn't
exist yet, so — same idea as `/diagnostics` — Nurudeen can trigger a
real submission today just by opening two links in order:
1. Open `.../submissions?application_id=...&secret=...` — it starts a
   Browserbase session and hands back a `live_view_url` (open that,
   log in to AskUni for real, that's the one manual step) and a
   ready-to-open `next_step` link for step 2 — no need to construct it
   by hand.
2. Once logged in, open that `next_step` link — it drives the actual
   wizard fill-and-submit against the real AskUni site and returns
   what happened as JSON.

What's below is the original starting-skeleton writeup, kept as-is for
the parts that are still true (the story of why this exists).

What this is: the small always-on service that goes on Render, so that a
**Send to AskUni** button in the Orbuni team portal can (1) submit a
completed student application into the real askuni.com on your behalf,
and (2) later check askuni.com for a response (a university's decision,
or a commission payment) without you lifting a finger — after you've
logged in on askuni.com **once**, live, with your own hands.

## Why it needs to exist at all

Supabase's edge functions (what runs `orbuni-assistant`, the section
assistants) have no browser inside them — they can only call other
APIs, not drive a real website. Netlify only serves the static site.
Neither can open askuni.com, wait while you type your password into it,
and keep that browser tab alive afterward. This service is that missing
piece.

## The flow, end to end

1. Staff finishes an application in Orbuni's own portal and clicks
   **Send to AskUni**.
2. The portal calls `POST /submissions` on this service with the
   application's id.
3. This service asks **Browserbase** (a hosted "real browser in the
   cloud" service — see below) to open a fresh browser at askuni.com's
   real login page, and hands back a **Live View URL** — a link that
   shows that exact browser, live, in the staff member's own browser
   tab. Nothing about the page is faked or proxied by us; it's
   askuni.com's own login form, so the password goes straight to them.
4. Staff opens that link and logs in themselves, the one time.
5. Once logged in, Browserbase can save that authenticated session as a
   reusable **context**. Every submission or response-check after that
   reuses the saved context instead of asking anyone to log in again —
   this is the part that makes "check back automatically" actually
   possible.
6. This service then drives the rest — filling in the student's
   details, uploading their documents, submitting — using Playwright
   commands sent to that same Browserbase browser (not typed by a
   human; the human's part was only the login).
7. A scheduled check (a Render Cron Job, or a periodic call from
   Supabase) reuses the saved context to look at askuni.com for
   anything new, and writes what it finds back into Orbuni's own
   database — a decision onto the student's application row, a
   commission amount into `finance_transactions` (same shape as a
   manual Finance entry, and now linked to the real `application_id`).

## What's confirmed for real (17 Sep 2026)

You did a real application for a real student, Usman Shehu Maisango,
end to end, and screenshotted the whole thing — that's what unblocked
almost all of this:

- The portal is at `apply.askuni.com` (not `askuni.com/login`).
- "Add a student" is a 4-step **"Add Student User"** modal, opened from
  `apply.askuni.com/users/student/list/`: **01 Account Details** (First
  Name, Last Name, Email, Gender, Mobile Phone with a country picker
  defaulted to +90, Profile Picture) → **02 Student Information** →
  **03 Documents** → **04 Apply**.
- **04 Apply** is a programme search box, a results list, an "Are you
  sure?" confirmation dialog (University / Program / Season, CANCEL /
  APPLY), then an "Application submit!" toast — landing on the
  student's own profile page at
  `apply.askuni.com/users/student/<id>/applications/` with an "All
  steps are completed!" toast and a new row in that page's Applications
  table.
- The **Commissions page** (`apply.askuni.com/application/commissions/`)
  picks up the new commission automatically — Usman's showed as $349.60
  at 50%, right alongside pre-existing rows, with columns Student,
  Application Status, Giver, Taker, Commission %, Status, Amount,
  Remaining.

Steps 01, 02, and 04 are written for real in `index.js` off the above
(step 02 from a second, more complete screenshot batch — see the top of
this file).

I also checked Orbuni's actual Supabase schema directly (rather than
guessing column names, which the first version of this file did) — the
real shape is: `applications` only holds `profile_id` + `programme_id`
+ `status`/`decision`; the student's own details live on `profiles`;
the programme and university live on `programmes` → `universities`;
uploaded files live on `documents` (one row per file, `kind` enum:
`profile_photo`, `passport`, `passport_photo`, `certificate`,
`transcript`, `english_test`, `birth_certificate`, `other`,
`offer_letter`, `acceptance_letter`, `visa_document`,
`payment_receipt`). `index.js` now joins across those for real instead
of reading columns that don't exist. I also added two columns to
`applications` — `askuni_student_id` and `askuni_synced_at` — so a
submitted application remembers which real AskUni student record it
became, instead of every later response-check having to guess by name.

## What's still a best-effort guess, not confirmed

**03 Documents** is inferred from the completed student's own
"Essential Documents" page (Passport / Diploma / Transcript / Profile
Picture) rather than a screenshot of step 03 itself mid-fill — flag it
as the first thing to check if a real submission throws partway
through.

Left unset on purpose, same reasoning throughout — better blank than
wrong on a real student's real application:
- **Gender** (step 01) — a dropdown; real option values never seen.
- **Mobile Phone** (step 01) — has a separate country-code picker
  defaulted to +90; whether it's a dropdown or a typeahead was never
  seen.
- **Country of Birth, Country of Residence, Nationality** (step 02) —
  all dropdowns; whether AskUni's dropdown widget is a plain list or a
  custom searchable box was never seen, so nothing here risks a
  `.selectOption()` call that could silently fail on the wrong kind.
- **Passport Date of Issue, Need Visa** (step 02) — no matching data
  exists anywhere in Orbuni's database yet for either one.

None of these block a real submission — they'll just show up blank on
AskUni's side for staff to fill in by hand afterward, same as before.

`readAskUniResponses()` (the Commissions-page reader) is written
generically off the table's own header row rather than guessed CSS
classes, since no "Inspect Element" view of a row was ever captured —
that makes it robust to AskUni changing their styling, but it still
matches a commission back to one of your applications by the
student's name when there's no `askuni_student_id` yet (true for
anything submitted by hand before this bot existed). Once this bot
submits applications for real, that matching gets exact.

## What's already done, and what's left

Render account: done. Browserbase account: done. Both env vars set.
`/diagnostics` confirms both are live. All four wizard steps are
written. **The only thing left is trying a real submission** — see
"Trying a real submission" below.

## Environment variables this service needs (set in Render, not here)

- `BROWSERBASE_API_KEY` — from browserbase.com (the API key alone identifies
  the project now — Browserbase confirms no separate project id is needed)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — same project as everything else
- `ASKUNI_PORTAL_URL` — defaults to `https://apply.askuni.com`, confirmed real
- `INTERNAL_SHARED_SECRET` — a random password only the Orbuni portal and
  this service know, so nobody else can call these endpoints
