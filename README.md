# Orbuni ⇄ AskUni bot — deployed, all four wizard steps written

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
end-to-end submission right now. What's below is the original
starting-skeleton writeup, kept as-is for the parts that are still
true (the story of why this exists).

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
