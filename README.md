# Orbuni ⇄ AskUni bot — version 3 (25 Sep 2026)

This small service runs on Render. When a staff member presses **Send to AskUni** on an
application in the Orbuni portal, it opens a browser **on this Render server**, logs in to
apply.askuni.com, fills AskUni's four-step "Add Student User" form (account details,
student information, documents, apply), and saves AskUni's student number on the Orbuni
application. It can also check AskUni for university responses.

## What changed in version 3: no more Browserbase

Versions 1 and 2 rented a browser from Browserbase. Its free plan gives one browser-hour a
month, which ran out on 20 Sep, and the paid plan is $20/month. Version 3 installs its own
headless Chrome inside the service when Render builds it (see `postinstall` in
`package.json`) and runs it on the same server. **Browserbase isn't used at all any more**;
its API key can be deleted from Render.

Because there is no live window any more, the bot logs in to AskUni by itself, with the
login you keep in Render's settings (below). The password is only ever typed into AskUni's
own login form. It is never written to a log, the database or a screenshot label, and it
is not in this code or on GitHub.

The server has 512 MB of memory, enough for one browser, so the bot sends **one student at a
time**. A second send while one is filling gets "busy, try again in a minute".

## Why version 1 never got a student through (found 20–24 Sep)

AskUni's first page requires *Gender* and a *Mobile Phone* (which defaults to a +90 Turkish
flag). Version 1 filled neither, so AskUni stayed on page 1. Every later field then "wasn't
found", and the programme search timed out. Orbuni never collected gender at all; the portal
now asks for it.

## How a send works

1. The portal shows a checklist of the 16 fields and 4 documents AskUni needs, and staff fill
   any gaps right there.
2. The bot logs in (or reuses the login from the last send), opens "Add Student User", and
   fills and checks each page before pressing Next.
3. If AskUni refuses to move on, the bot stops with AskUni's own words (e.g. "Gender — This
   field is required") and a picture of the AskUni screen. It keeps the form open for 10
   minutes (`HOLD_MINUTES`). Staff press **Fix the details**, correct the student's file, and
   press **Save and carry on**. The bot re-reads the student from Orbuni and resumes from
   that page.
4. On the Apply page it picks the result row that matches both the course and the
   university, confirms, and records AskUni's student number.
5. The browser is always closed at the end, whether the send succeeded, failed or was cancelled.

## Environment variables (Render → askuni-bot → Environment)

- `ASKUNI_EMAIL`, `ASKUNI_PASSWORD`: the AskUni partner login. **Type these into Render
  yourself. Never paste them into a chat, an email or GitHub.**
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: already set.
- `INTERNAL_SHARED_SECRET`: already set (the same value the `askuni-proxy` edge function uses).
- `ASKUNI_PORTAL_URL`: optional, defaults to `https://apply.askuni.com`.
- `HOLD_MINUTES`: optional, default 10.
- `BROWSERBASE_API_KEY`: no longer used; delete it.

## Routes (all need the `x-internal-secret` header)

| Route | What it does |
|---|---|
| `GET /diagnostics` | Is the AskUni login set? Does the browser start (and how fast)? Is Supabase reachable? Memory in use. |
| `POST /submissions` `{application_id, staff_id}` | Starts a send. |
| `POST /submissions/:id/continue` `{submission_id, application_id}` | Carries on after the student's details were fixed. |
| `POST /submissions/:id/cancel` | Stops and closes the browser. |
| `POST /check-responses` | Reads AskUni's list for university decisions and commissions. |

The portal never calls these directly. It goes through the Supabase edge function
`askuni-proxy`, which checks that the staff member is allowed to manage applications.

## Files

- `index.js`: the start file. It tells Playwright where the browser is, then loads `server.js`.
- `server.js`: the web service, the browser, logging in, job tracking.
- `askuni-fill.js`: everything that knows AskUni's pages. It covers the login form, fields
  found by their label, dropdowns and country lists, phone and date formats, uploads,
  AskUni's error messages and the four steps.
- `test/`: a local copy of AskUni's login and form, and a script that drives the bot through
  it (`node test/run-mock.mjs`). Not needed on Render.

## Deploying

Upload `index.js`, `server.js`, `askuni-fill.js`, `package.json` and this README to the GitHub
repo `nurudeen-ui/askuni-bot`, replacing the old files. Add `ASKUNI_EMAIL` and
`ASKUNI_PASSWORD` in Render, then redeploy. The first build takes a few minutes longer,
because it downloads the browser.
