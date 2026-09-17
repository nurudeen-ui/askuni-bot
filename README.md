# Orbuni ⇄ AskUni bot — starting skeleton

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

Steps 01 and 04 are written for real in `index.js` off the above.

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

## What's still genuinely blocked

**02 Student Information and 03 Documents.** Your screenshots covered
the whole flow, but the images themselves didn't make it into the
working session where this code got written — only a written summary
of the overall flow did, and that summary doesn't include the exact
field labels for these two specific steps (it's very solid on 01 and
04, which is why those are the two that got written).

The actual, narrow ask — nothing more than this: **one screenshot each
of "02 Student Information" and "03 Documents," mid-fill**, same as
you already did for the others. Once those two exist, the rest of
`fillAskUniApplication()` writes the same way 01 did. No need to redo
the whole walkthrough — just those two screens.

Also still a guess: the exact button that opens the "Add Student User"
modal from the student list page (not itself screenshotted), and the
Gender dropdown's real option values / the Mobile Phone country-code
picker's real interaction (dropdown vs. typeahead) — both left unset
in step 01 for now rather than risk filling them in wrong.

`readAskUniResponses()` (the Commissions-page reader) is written
generically off the table's own header row rather than guessed CSS
classes, since no "Inspect Element" view of a row was ever captured —
that makes it robust to AskUni changing their styling, but it still
matches a commission back to one of your applications by the
student's name when there's no `askuni_student_id` yet (true for
anything submitted by hand before this bot existed). Once this bot
submits applications for real, that matching gets exact.

## What you (Nurudeen) need to do before this can run for real

1. **Create a Render account** at render.com — no download, it's a
   website. Then connect the Render app in your Claude/Cowork
   connector settings so I can deploy and manage this service directly
   from our chats, the same way the Netlify connector already works.
   Cheapest always-on plan is currently about **$7/month** (their free
   tier sleeps when idle, which would break "check back automatically").
2. **Create a Browserbase account** at browserbase.com — also just a
   website, no download. Their Developer plan is currently **$20/month**
   for 100 browser-hours, which comfortably covers occasional
   submissions plus regular response checks. There's no Claude connector
   for Browserbase yet, so once you have an account, get its API key
   from their dashboard and give it to me as a Render **environment
   variable** (never typed into our chat) — I'll walk you through exactly
   where to paste it once your Render account is connected.
3. Two screenshots (02 and 03, above) to finish the form-filling.
4. Everything else (the actual deploy, the Supabase wiring, the button
   in your portal) I can do once those exist.

## Environment variables this service needs (set in Render, not here)

- `BROWSERBASE_API_KEY` — from browserbase.com (the API key alone identifies
  the project now — Browserbase confirms no separate project id is needed)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — same project as everything else
- `ASKUNI_PORTAL_URL` — defaults to `https://apply.askuni.com`, confirmed real
- `INTERNAL_SHARED_SECRET` — a random password only the Orbuni portal and
  this service know, so nobody else can call these endpoints
