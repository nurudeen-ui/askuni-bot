# Orbuni ⇄ AskUni bot — starting skeleton

What this is: the small always-on service that goes on Render, so that a
"Send to AskUni" button in the Orbuni team portal can (1) submit a
completed student application into the real askuni.com on your behalf,
and (2) later check askuni.com for a response (a university's decision,
or a commission payment) without you lifting a finger — after you've
logged in on askuni.com **once**, live, with your own hands.

## Why it needs to exist at all

Supabase's edge functions (what runs `askuni`, the Finance assistant)
have no browser inside them — they can only call other APIs, not drive
a real website. Netlify only serves the static site. Neither can open
askuni.com, wait while you type your password into it, and keep that
browser tab alive afterward. This service is that missing piece.

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
   manual Finance entry).

## What's real vs. what's still a placeholder in this skeleton

Real and working, once deployed with real keys:
- The Browserbase session creation + Live View URL hand-back
  (`POST /submissions`).
- The context-save-and-reuse plumbing (`getOrCreateContext`).
- The Express server shape, env var loading, and the Supabase writes.

Still a placeholder — **cannot be written correctly without seeing
askuni.com's actual submission form and response pages**:
- `fillAskUniApplication()` — the actual field-by-field form-filling
  and document upload. Needs real selectors (field names, upload
  button, submit button) from the real page.
- `readAskUniResponses()` — the actual "check for a decision or a
  payment" logic. Needs to know what a decision and a commission
  notice actually look like on askuni.com.

The honest next step on those two functions is either a short screen-
share walkthrough of askuni.com's submission flow, or (better) a test/
sandbox account on askuni.com to build and rehearse against without
touching a real student's live application while getting it right.

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
3. Everything else (the actual deploy, the Supabase wiring, the button
   in your portal) I can do once those two accounts exist.

## Environment variables this service needs (set in Render, not here)

- `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` — from browserbase.com
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — same project as everything else
- `ASKUNI_PORTAL_URL` — askuni.com's real login page URL
