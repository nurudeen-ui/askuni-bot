// Orbuni ⇄ AskUni bot — see README.md for the full story.
// Deliberately small and readable rather than clever: Nurudeen is
// non-technical and will want to point at this file and ask "what does
// this part do" more than once.
//
// NOT YET DEPLOYED ANYWHERE. Needs a Render account + a Browserbase
// account + real env vars before any of this actually runs. See
// README.md "What you need to do before this can run for real".

import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";

const env = (k, fallback) => process.env[k] ?? fallback;
const PORT = env("PORT", 3000);
const ASKUNI_PORTAL_URL = env("ASKUNI_PORTAL_URL", "https://apply.askuni.com");
// Confirmed from Nurudeen's own screenshots, 17 Sep 2026: the real portal
// lives at apply.askuni.com (not askuni.com/login as first guessed).
// "Add a student" is a 4-step wizard opened from apply.askuni.com/users/student/list/:
//   01 Account Details — First Name, Last Name, Email, Gender, Mobile
//      Phone (country-code picker, defaulted to +90 Turkey), Profile
//      Picture (file upload) — then a "Next" button. WRITTEN BELOW.
//   02 Student Information — Passport Number, Birth Date, Country of
//      Birth, Country of Residence, Nationality, City of Residence,
//      Address, Mother Name, Father Name, Passport Date of Expire,
//      Passport Date of Issue, Need Visa (toggle). WRITTEN BELOW.
//   03 Documents — best-effort, see fillAskUniApplication().
//   04 Apply (search a programme, pick it, confirm) — WRITTEN BELOW, from
//      watching Nurudeen actually submit a real application for a real
//      student (Usman Shehu Maisango) on 17 Sep 2026: he searched
//      "information", picked "Management Information Systems (English)"
//      at Istanbul Nisantasi University ($3,800, Bachelor), got an "Are
//      you sure?" dialog (University / Program / Season, CANCEL / APPLY),
//      then an "Application submit!" toast, landing on
//      apply.askuni.com/users/student/280784/applications/ with "All
//      steps are completed!" and a new row in the Applications table.
//      His new commission ($349.60, 50%) showed up on the Commissions
//      page right alongside pre-existing rows.

const bb = new Browserbase({ apiKey: env("BROWSERBASE_API_KEY", "") });
// No project id needed — Browserbase resolves the project from the API
// key alone (confirmed against their current docs, 17 Sep 2026).

const sb = createClient(env("SUPABASE_URL", ""), env("SUPABASE_SERVICE_ROLE_KEY", ""));

const app = express();
app.use(express.json());

// A staff member should only ever be able to trigger this from inside
// the already-authenticated Orbuni team portal — this shared-secret
// check is a stand-in for wiring real auth through once this is
// actually deployed (e.g. verifying the same Supabase JWT the orbuni
// edge function checks, via can_manage_section("applications")).
// A query-param fallback (?secret=...) is accepted too, same pattern
// send-student-emails already uses — that's what lets a plain browser
// URL hit /diagnostics for a quick manual check, not just a header a
// script can set.
function requireInternalAuth(req, res, next){
  const got = req.headers["x-internal-secret"] || req.query.secret || "";
  if(!process.env.INTERNAL_SHARED_SECRET || got !== process.env.INTERNAL_SHARED_SECRET){
    return res.status(401).json({ error: "not authorised" });
  }
  next();
}

// ---- one saved context per Orbuni "seat" on askuni.com -----------------
// A context is Browserbase's word for "the cookies/local storage from a
// login, saved so a later session can start already signed in." We keep
// its id in Supabase so a restart of this service doesn't lose it and
// force a re-login.
async function getSavedContextId(){
  const { data, error } = await sb.from("integration_settings").select("value").eq("key", "askuni_context_id").maybeSingle();
  if(error) throw new Error("couldn't read the saved AskUni login from Supabase: " + error.message);
  return data?.value || null;
}
async function saveContextId(id){
  // 17 Sep 2026 bug found here: this used to await the upsert without ever
  // checking its `error` — so the very first time this ran, before the
  // `integration_settings` table existed, the save silently did nothing
  // (no throw, no log) while a real Browserbase context had already been
  // created. Every attempt after that tried to create ANOTHER context
  // under the same fixed name and got a real 409 "already exists" from
  // Browserbase — the actual cause of the second live-test failure. Now
  // this throws loudly instead of failing silently.
  const { error } = await sb.from("integration_settings").upsert({ key: "askuni_context_id", value: id });
  if(error) throw new Error("couldn't save the AskUni login (context " + id + ") to Supabase: " + error.message);
}

// ---- loading one Orbuni application with everything the wizard needs ---
// Real schema, checked directly against Supabase 17 Sep 2026 — this
// replaces the earlier version of this file, which guessed at flat
// columns (first_name, email, passport_file_path...) that don't actually
// exist on `applications`. The real shape: `applications` only holds
// profile_id + programme_id + status; the student's own details live on
// `profiles`, the programme/university on `programmes`/`universities`,
// and uploaded files on `documents` (one row per file, keyed by
// profile_id + a `kind` enum).
// `student_details` (one row per profile_id, profile_id is its own
// primary key — checked directly, 17 Sep 2026 night) is where most of
// AskUni step 02's fields actually live: passport_number, date_of_birth,
// place_of_birth, nationality, mother_name, father_name, address_line,
// city, country, passport_expiry. Joining it here the same way
// profiles/programmes/universities already are.
async function loadApplication(applicationId){
  const { data: appRow, error } = await sb.from("applications")
    .select("*, profiles(*, student_details(*)), programmes(*, universities(*))")
    .eq("id", applicationId).maybeSingle();
  if(error) throw error;
  if(!appRow) return null;

  const { data: docs } = await sb.from("documents")
    .select("*").eq("profile_id", appRow.profile_id).eq("status", "verified");

  return { ...appRow, documents: docs || [] };
}
function findDoc(app_row, kind){
  return (app_row.documents || []).find(d => d.kind === kind) || null;
}

// ---- a quick, safe self-check ------------------------------------------
// Doesn't touch askuni.com or spend a real Browserbase session — just
// confirms the two credentials this service depends on actually work, so
// whether they're set correctly can be checked directly instead of by
// asking Nurudeen to keep re-confirming what he already sent.
app.get("/diagnostics", requireInternalAuth, async (_req, res) => {
  const out = { browserbase: "unknown", supabase: "unknown" };
  try{
    await bb.projects.list();
    out.browserbase = "ok";
  }catch(e){
    out.browserbase = "failed: " + String(e && e.message || e);
  }
  try{
    const { error } = await sb.from("applications").select("id").limit(1);
    out.supabase = error ? ("failed: " + error.message) : "ok";
  }catch(e){
    out.supabase = "failed: " + String(e && e.message || e);
  }
  res.json(out);
});

// ---- step 1: staff clicks "Send to AskUni" ------------------------------
// Returns a Live View URL. The portal shows this as "Click here to sign
// in to AskUni" — staff opens it, sees AskUni's REAL login page (this
// service never sees the password), logs in, and comes back.
//
// Registered for BOTH POST (what the real "Send to AskUni" button in the
// Orbuni portal will call, once that button exists) and GET (so this can
// be triggered right now by opening a plain URL in a browser — same
// pattern as /diagnostics — before that portal button is built). Reading
// `application_id` from either the query string or a JSON body covers
// both.
async function handleStartSubmission(req, res){
  try{
    const application_id = req.query.application_id || (req.body && req.body.application_id);
    if(!application_id) return res.status(400).json({ error: "application_id required" });
    console.log("[submissions/start] application_id=" + application_id);

    let contextId = await getSavedContextId();
    if(!contextId){
      console.log("[submissions/start] no saved context — creating one");
      // No `name` here on purpose (17 Sep 2026 fix): Browserbase context
      // names must be unique per project, and an earlier attempt — from
      // before `integration_settings` existed, when the save silently
      // failed (see saveContextId above) — already created one real
      // context named "orbuni-askuni" in Browserbase that this service
      // has no id for. Every retry that reused that same fixed name hit a
      // real 409 "already exists" from Browserbase, which is exactly what
      // Nurudeen's second live test hit. A name was only ever cosmetic —
      // the login this context holds is found again by its id, saved
      // right below — so leaving it unnamed makes this create call safe
      // to retry forever.
      const ctx = await bb.contexts.create({});
      contextId = ctx.id;
      await saveContextId(contextId);
      console.log("[submissions/start] created + saved context " + contextId);
    }

    const session = await bb.sessions.create({
      browserSettings: { context: { id: contextId, persist: true } },
    });
    console.log("[submissions/start] created session " + session.id);
    // Real Browserbase SDK method, confirmed against their current docs —
    // an earlier version of this file called a method (sessions.liveUrls.create)
    // that does not exist on the SDK at all, which is exactly the kind of
    // silent-until-clicked bug this comment is here to warn about happening
    // again: always check a method against the SDK's own docs, not a
    // remembered shape, before trusting it in code nobody has run yet.
    const debugInfo = await bb.sessions.debug(session.id);
    // 18 Sep 2026, ninth real test: Nurudeen's real complaint was that
    // clicking "Send to AskUni" took him to a whole separate browser tab
    // to log in, and on his phone he had no reliable way back to the
    // Orbuni tab he came from. `debuggerFullscreenUrl` is meant to be
    // opened as its own standalone page (a new tab) — that's the ONLY
    // url this endpoint ever returned before. Browserbase's SDK also
    // hands back `debuggerUrl`, which is the one meant to be embedded in
    // an <iframe> on someone else's page — returning both lets the
    // frontend show the real login screen inline, inside the same
    // Orbuni card, instead of sending anyone to a different tab at all.
    // `live_view_url` (fullscreen) is kept as a fallback link in case the
    // embed doesn't render for some reason — this sandbox can't reach
    // Browserbase's own domain to confirm the iframe actually renders, so
    // treat that fallback as load-bearing, not decorative, until a real
    // test confirms the embed works.
    const liveViewUrl = debugInfo.debuggerFullscreenUrl;
    const liveViewEmbedUrl = debugInfo.debuggerUrl || liveViewUrl;
    console.log("[submissions/start] got live view url (embeddable: " + (debugInfo.debuggerUrl ? "yes" : "no, falling back to fullscreen") + ")");

    // 18 Sep 2026 bug found here: a brand-new Browserbase session opens on
    // a completely blank page — nothing about this code ever sent it
    // anywhere. Nurudeen opening the live view therefore saw an empty
    // "about:blank" tab with no clue what to do, and typing AskUni's own
    // URL in by hand (which he tried) still leaves him unsure whether
    // he's even looking at the right browser. Fixed by driving this same
    // session, via the same CDP connection the /continue step uses later,
    // straight to the real login page before anyone ever opens the live
    // view — so the tab that opens is already sitting on AskUni's actual
    // login form, ready to type a password into. Deliberately NOT calling
    // browser.close() afterward: on a CDP-connected browser that ends the
    // whole remote session, which would kill the very session Nurudeen is
    // about to log into — only /continue (once the wizard is truly done)
    // should ever close it.
    try{
      const startBrowser = await chromium.connectOverCDP(
        `wss://connect.browserbase.com?apiKey=${env("BROWSERBASE_API_KEY","")}&sessionId=${session.id}`
      );
      const startPage = startBrowser.contexts()[0].pages()[0];
      await startPage.goto(ASKUNI_PORTAL_URL + "/login/", { waitUntil: "domcontentloaded", timeout: 30000 });
      console.log("[submissions/start] pre-navigated the live session to /login/");
    }catch(navErr){
      // Non-fatal: worst case Nurudeen lands on a blank tab and has to
      // type the URL himself, same as before this fix — but the session
      // and live view link below still work either way.
      console.error("[submissions/start] pre-navigation to /login/ failed (non-fatal): " + String(navErr && navErr.message || navErr));
    }

    // Stash which application this session is for, so /submissions/:id/continue
    // (called once staff confirms they've logged in) knows what to do next.
    const logged = await sb.from("ai_actions").insert({
      section: "applications",
      action_type: "askuni_submission_started",
      proposal: { application_id, browserbase_session_id: session.id },
      summary: "Started an AskUni submission — waiting on manual login",
      created_by: (req.body && req.body.staff_id) || null,
    });
    if(logged.error) console.log("[submissions/start] ai_actions insert failed (non-fatal): " + logged.error.message);

    // next_step spells out, in the response itself, exactly what to open
    // next and with what query params — so this can be driven purely by
    // clicking links in a browser, without reading the code.
    const secretPart = process.env.INTERNAL_SHARED_SECRET
      ? "&secret=" + encodeURIComponent(process.env.INTERNAL_SHARED_SECRET) : "";
    res.json({
      session_id: session.id,
      live_view_url: liveViewUrl,
      live_view_embed_url: liveViewEmbedUrl,
      application_id,
      next_step: "Open live_view_embed_url in an iframe (or live_view_url in a new tab if the embed fails) and log in to AskUni for real. THEN, once logged in, open: " +
        req.protocol + "://" + req.get("host") + "/submissions/" + session.id + "/continue?application_id=" + application_id + secretPart,
    });
  }catch(e){
    console.error("[submissions/start] FAILED: " + String(e && e.stack || e));
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
app.post("/submissions", requireInternalAuth, handleStartSubmission);
app.get("/submissions", requireInternalAuth, handleStartSubmission);

// 18 Sep 2026: this real live test — the first to get past login at all —
// timed out 30s into the very first click ("ADD STUDENT USER"), with no
// way to see what the real page actually looked like at that moment
// (Browserbase's live view only helps while someone is watching it live;
// this ran unattended after Nurudeen clicked Continue and closed the tab).
// From now on, ANY failure inside fillAskUniApplication() takes a real
// screenshot of whatever askuni.com was showing at the moment it broke,
// uploads it to the same "chat" Storage bucket Orbuni's own attachments
// already use (service-role key, so no new bucket/policy needed), and
// puts a signed link to it right in the error — so the next failure comes
// with a picture of the real page instead of another guessing round.
async function screenshotOnFailure(page, label){
  try{
    const buf = await page.screenshot({ fullPage: true });
    const path = "askuni-debug/" + Date.now() + "-" + label.replace(/[^a-z0-9]+/gi, "-") + ".png";
    const up = await sb.storage.from("chat").upload(path, buf, { contentType: "image/png" });
    if(up.error){ console.error("[screenshotOnFailure] upload failed: " + up.error.message); return null; }
    const signed = await sb.storage.from("chat").createSignedUrl(path, 60 * 60 * 24 * 7);
    return signed.data ? signed.data.signedUrl : null;
  }catch(e){
    console.error("[screenshotOnFailure] itself failed: " + String(e && e.message || e));
    return null;
  }
}

// 18 Sep 2026 (night) bug found here: Nurudeen clicked "I'm logged in —
// Continue" twice within 25 seconds (the button gave him no visible
// "working…" state, so a fair click again). That fired TWO overlapping
// handleContinueSubmission calls against the very same Browserbase
// session — two separate Playwright connections both driving the same
// browser tab at once. The first one's navigation genuinely timed out,
// its catch block closed the browser (correct — CDP browser.close() ends
// the whole remote session), and the second one — still mid-navigation
// on the now-dead session — failed right after with "Target page,
// context or browser has been closed". That's also exactly what the
// live-view tab showed him: "Debugging connection was closed." This set
// tracks which sessionIds already have a continue in flight, so a
// second click on the same session is rejected immediately with a clear
// message instead of racing the first one.
const continuesInFlight = new Set();

// ---- step 2: staff clicks "I've logged in, continue" -------------------
// Same GET+POST treatment as above, for the same reason.
async function handleContinueSubmission(req, res){
  let browser = null;
  const { sessionId } = req.params;
  if(continuesInFlight.has(sessionId)){
    console.log("[submissions/continue] rejected duplicate call for sessionId=" + sessionId + " — one is already running");
    return res.status(409).json({ error: "Already submitting this application — give it a minute rather than clicking Continue again." });
  }
  continuesInFlight.add(sessionId);
  try{
    const application_id = req.query.application_id || (req.body && req.body.application_id);
    console.log("[submissions/continue] sessionId=" + sessionId + " application_id=" + application_id);

    const app_row = await loadApplication(application_id);
    if(!app_row) return res.status(404).json({ error: "application not found" });

    browser = await chromium.connectOverCDP(
      `wss://connect.browserbase.com?apiKey=${env("BROWSERBASE_API_KEY","")}&sessionId=${sessionId}`
    );
    const page = browser.contexts()[0].pages()[0];
    // 18 Sep 2026: the first real click after this session's login timed
    // out 30 seconds into the very first step, with the call log showing
    // AskUni's list page was still settling (a client-rendered page, not
    // a plain server-rendered one — the URL can finish loading well
    // before the actual content/buttons appear). Playwright's default
    // per-action timeout was only 30s; a cold Browserbase browser + a
    // real remote site's own load time can genuinely take longer than
    // that on the very first page after logging in. Raised to 60s for
    // every action in this flow, not just the first one.
    page.setDefaultTimeout(60000);
    console.log("[submissions/continue] connected to browser, filling wizard…");

    let result;
    try{
      result = await fillAskUniApplication(page, app_row);
    }catch(fillErr){
      const shotUrl = await screenshotOnFailure(page, "continue-" + sessionId);
      throw new Error(String(fillErr && fillErr.message || fillErr) + (shotUrl ? " — screenshot: " + shotUrl : " — (couldn't capture a screenshot either)"));
    }
    await browser.close();
    console.log("[submissions/continue] done: " + JSON.stringify(result));

    res.json({ ok: true, result });
  }catch(e){
    if(browser){ try{ await browser.close(); }catch{} }
    console.error("[submissions/continue] FAILED: " + String(e && e.stack || e));
    res.status(500).json({ error: String(e && e.message || e) });
  }finally{
    continuesInFlight.delete(sessionId);
  }
}
app.post("/submissions/:sessionId/continue", requireInternalAuth, handleContinueSubmission);
app.get("/submissions/:sessionId/continue", requireInternalAuth, handleContinueSubmission);

// ---- the scheduled half: check askuni.com for responses ----------------
// Point a Render Cron Job (or a periodic call from Supabase) at this.
// Reuses the saved context — no human needed, per Nurudeen's "keep it
// alive and automatically retrieve information" answer (17 Sep 2026).
app.post("/check-responses", requireInternalAuth, async (_req, res) => {
  try{
    const contextId = await getSavedContextId();
    if(!contextId) return res.status(409).json({ error: "no AskUni login saved yet — do one manual submission first" });

    const session = await bb.sessions.create({
      browserSettings: { context: { id: contextId, persist: true } },
    });
    const browser = await chromium.connectOverCDP(
      `wss://connect.browserbase.com?apiKey=${env("BROWSERBASE_API_KEY","")}&sessionId=${session.id}`
    );
    const page = browser.contexts()[0].pages()[0];
    const found = await readAskUniResponses(page);
    await browser.close();

    for(const item of found){
      if(item.kind === "decision" && item.application_id){
        // item.status is either a real applications.status enum value
        // (offer_received / rejected — the only two mapAskUniStatus()
        // currently recognises) or the raw AskUni text for anything else.
        // Only the enum gets written to `status`; the raw text always
        // goes into `decision` either way, so nothing is lost even when
        // it isn't recognised yet.
        const KNOWN_STATUSES = ["offer_received", "rejected"];
        const patch = { decision: item.status, decision_at: new Date().toISOString(), askuni_synced_at: new Date().toISOString() };
        if(KNOWN_STATUSES.includes(item.status)) patch.status = item.status;
        await sb.from("applications").update(patch).eq("id", item.application_id);
      }
      if(item.kind === "commission"){
        // Same shape a manual Finance entry uses, so a commission that
        // arrives via AskUni looks identical in the ledger to one typed
        // by hand. application_id is a real FK on finance_transactions —
        // link it whenever we managed to match the row to one of ours.
        await sb.from("finance_transactions").insert({
          kind: "income", direction: "in", amount: item.amount, currency: item.currency || "USD",
          application_id: item.application_id || null,
          description: "AskUni — " + item.description,
          occurred_on: new Date().toISOString().slice(0,10), source: "automatic",
        });
      }
    }
    res.json({ ok: true, found: found.length });
  }catch(e){
    console.error("[check-responses] FAILED: " + String(e && e.stack || e));
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// ================= THE FUNCTIONS THAT NEED ASKUNI'S REAL PAGE ===========

// 18 Sep 2026, eighth real test (Passport Number): AskUni's page has now
// shown TWO different flavors of the same underlying problem — invisible
// duplicate inputs that share a label with the real, fillable field.
//   - Email (sixth test): getByLabel found TWO candidates. The error's own
//     call log listed both, so the real one could be picked by its actual
//     id (#eMail) — a confirmed fix, not a guess.
//   - Passport Number (eighth test): getByLabel found only ONE candidate,
//     and Playwright reported THAT ONE as "not visible" for the full 60s
//     timeout. There's no second candidate to fall back to from the error
//     alone — the real field's selector is simply unknown from this
//     evidence.
// Rather than waiting for a screenshot of every one of the many still-
// untested fields in steps 02-04 and hand-fixing each with a guessed or
// confirmed id one at a time, this helper does what a sighted person would
// do: try every element getByLabel matches and use the first one that's
// actually visible; if none are visible, find the label's own text on the
// page and fill the nearest real input that follows it. This is a
// deliberate hedge against the SAME pattern recurring, not a claim that it
// fixes Passport Number specifically — if it still can't find a visible
// field, it logs that plainly and leaves the value blank (same "better
// blank than wrong" rule used everywhere else in this file) rather than
// filling the wrong hidden input.
async function smartFill(page, label, value, opts = {}){
  if(!value) return { filled: false, reason: "no value" };
  const timeout = opts.timeout || 8000;

  const candidates = await page.getByLabel(label, { exact: opts.exact || false }).all();
  for(const el of candidates){
    try{
      if(await el.isVisible()){
        await el.fill(value, { timeout });
        console.log(`[smartFill] "${label}": filled via getByLabel (${candidates.length} candidate(s) checked)`);
        return { filled: true, method: "getByLabel" };
      }
    }catch(e){ /* try the next candidate */ }
  }

  // No visible getByLabel match (Passport Number's exact failure mode) —
  // fall back to the label's own visible text on the page, then the
  // nearest real <input>/<textarea> that follows it in the DOM.
  try{
    const labelNode = page.getByText(label, { exact: false }).first();
    const nearInput = labelNode.locator(
      "xpath=following::input[not(@type='hidden')][1] | following::textarea[1]"
    ).first();
    if(await nearInput.count() && await nearInput.isVisible()){
      await nearInput.fill(value, { timeout });
      console.log(`[smartFill] "${label}": filled via text-proximity fallback (0 visible getByLabel candidates)`);
      return { filled: true, method: "text-proximity" };
    }
  }catch(e){ /* fall through to the blank-not-wrong log below */ }

  console.warn(`[smartFill] "${label}": no visible field found (${candidates.length} getByLabel candidate(s), all hidden, no text-proximity match either) — left blank rather than filling the wrong input`);
  return { filled: false, reason: "no visible field found" };
}

// 18 Sep 2026, ninth real test: a real submission's own logs caught the
// exact failure this was missing — step 03's document upload loop called
// the raw `page.getByLabel(label).setInputFiles(...)` with no resilience
// at all, and a real Diploma upload timed out after the default 60s and
// THREW, which aborted the whole submission and discarded every field
// step 01/02 had already filled successfully. smartFill() (above) already
// solved this exact shape of problem for text fields — same guessed/
// unconfirmed label risk, same "better blank than wrong" philosophy — but
// it calls `.fill()`, which doesn't apply to a file input. This is that
// same fix, adapted for `setInputFiles`: try every getByLabel candidate
// and use the first visible one, with a short timeout instead of the
// default 60s, and if none are visible, log it plainly and move on rather
// than throwing. A skipped document is a real gap Nurudeen can catch and
// re-upload by hand from the student's profile page; a crashed submission
// throws away everything, including the fields that DID work.
async function trySetInputFiles(page, label, filePath, opts = {}){
  const timeout = opts.timeout || 8000;

  const candidates = await page.getByLabel(label, { exact: opts.exact || false }).all();
  for(const el of candidates){
    try{
      if(await el.isVisible()){
        await el.setInputFiles(filePath, { timeout });
        console.log(`[trySetInputFiles] "${label}": uploaded via getByLabel (${candidates.length} candidate(s) checked)`);
        return { uploaded: true, method: "getByLabel" };
      }
    }catch(e){ /* try the next candidate */ }
  }

  // No visible getByLabel match — fall back to the label's own visible
  // text on the page, then the nearest real file input that follows it.
  try{
    const labelNode = page.getByText(label, { exact: false }).first();
    const nearInput = labelNode.locator("xpath=following::input[@type='file'][1]").first();
    if(await nearInput.count()){
      await nearInput.setInputFiles(filePath, { timeout });
      console.log(`[trySetInputFiles] "${label}": uploaded via text-proximity fallback (0 visible getByLabel candidates)`);
      return { uploaded: true, method: "text-proximity" };
    }
  }catch(e){ /* fall through to the skip-not-crash log below */ }

  console.warn(`[trySetInputFiles] "${label}": no visible file input found (${candidates.length} getByLabel candidate(s), all hidden, no text-proximity match either) — skipped this document rather than crashing the whole submission`);
  return { uploaded: false, reason: "no visible field found" };
}

async function fillAskUniApplication(page, app_row){
  const student = app_row.profiles || {};
  const programme = app_row.programmes || {};
  const university = programme.universities || {};

  // 18 Sep 2026, second fix: the FIRST fix here (below) tried `networkidle`
  // to fix a too-early click on a still-loading page — but the very next
  // real attempt timed out at a full 60 seconds waiting for `networkidle`,
  // which never came at all. That's a known trap with `networkidle`: it
  // waits for NO network activity for 500ms, and a real logged-in
  // dashboard like AskUni's almost always has something running forever in
  // the background — a chat widget polling, an analytics beacon, a
  // websocket — so the page can be fully usable and still never go idle.
  // The actual fix is simpler than either previous attempt: don't wait for
  // the page to "settle" at all. `domcontentloaded` just confirms the HTML
  // itself has arrived, and the very next line's `.getByRole(...).click()`
  // ALREADY auto-waits (up to page.setDefaultTimeout, 60s) for that button
  // to actually exist and be clickable — Playwright does this on every
  // action by default. That auto-wait is what should have been carrying
  // this the whole time, not a navigation-level wait.
  console.log("[fillAskUniApplication] navigating to student list…");
  await page.goto(ASKUNI_PORTAL_URL + "/users/student/list/", { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("[fillAskUniApplication] list page loaded, waiting for Add Student to be clickable…");

  // Opening the wizard: confirmed for real, 17 Sep 2026 night — the
  // button on the student list page reads exactly "ADD STUDENT USER".
  // Kept as a case-insensitive /add student/i match rather than an exact
  // string so it still works if AskUni ever changes the casing.
  await page.getByRole("button", { name: /add student/i }).click();
  console.log("[fillAskUniApplication] Add Student clicked, filling step 01…");

  // ---- 01 Account Details (confirmed) ----
  await page.getByLabel("First Name").fill(student.first_name || "");
  await page.getByLabel("Last Name").fill(student.last_name || "");
  // 18 Sep 2026, sixth real test: `getByLabel("Email")` threw a Playwright
  // strict-mode error here — it matched TWO elements on the real page, not
  // one. Read directly from that error's own call log (not guessed):
  //   1) <input id=":r2:" ...> inside [id="__next"] — a React/MUI
  //      auto-generated id, almost certainly some other control on the
  //      page (e.g. an existing-student search box) that happens to also
  //      expose an accessible name of "Email".
  //   2) <input id="eMail" placeholder="example@gmail.com" ...> — this is
  //      the real new-student email field in the Add Student form.
  // Targeting the confirmed real id directly (`#eMail`) is unambiguous and
  // is not a guess — it's the exact id AskUni's own page reported for the
  // right field in that error's call log.
  await page.locator("#eMail").fill(student.email || "");
  // Gender is a dropdown — real option values not yet seen, so this is
  // left unset for now rather than guessing wrong ones:
  // await page.getByLabel("Gender").selectOption(...);
  // Mobile Phone has a separate country-code picker defaulted to +90
  // (Turkey) — the picker's real interaction (dropdown vs typeahead)
  // hasn't been seen, so this is also left unset for now:
  // await page.getByLabel("Mobile Phone").fill(student.phone || "");
  const profilePhoto = findDoc(app_row, "profile_photo");
  if(profilePhoto){
    // 18 Sep 2026, seventh real test: this threw a real "Object not found"
    // error — but not from askuni.com or the screenshot upload (both of
    // those were red herrings the error message made it look like at
    // first). Checked directly against the real storage.objects table:
    // every OTHER document kind (passport, transcript, certificate,
    // birth_certificate) really does live in the "documents" bucket, but
    // a profile photo is saved to the separate "avatars" bucket instead —
    // Orbuni's own upload flow for a student's photo has always kept it
    // there. `downloadToTemp` was hardcoded to "documents" for every kind,
    // so this was the one document that could never actually be found.
    await trySetInputFiles(page, "Profile Picture", await downloadToTemp(profilePhoto.storage_path, "avatars"));
  }
  await page.getByRole("button", { name: "Next" }).click();

  // ---- 02 Student Information (in-panel heading: "Personal Information")
  // — confirmed for real, 17 Sep 2026 night, from Nurudeen's second
  // screenshot batch (the one that finally caught the wizard from the
  // very start). Real fields: Passport Number, Birth Date (clearable
  // date picker), Country of Birth (dropdown), Country of Residence
  // (dropdown), Nationality (dropdown), City of Residence, Address,
  // Mother Name, Father Name, Passport Date of Expire (clearable date),
  // Passport Date of Issue (clearable date), Need Visa (toggle switch).
  //
  // Orbuni's own schema was checked again for real rather than guessed:
  // a `student_details` table (one row per profile_id) carries most of
  // these — passport_number, date_of_birth, nationality, mother_name,
  // father_name, address_line, city, country, passport_expiry.
  //
  // Left unset on purpose, same reasoning as Gender/Mobile Phone above —
  // better blank than wrong on a real student's real application:
  //   - Country of Birth: `student_details` only has `place_of_birth`,
  //     which was never confirmed to actually hold a country rather than
  //     a city/town — and it's a dropdown anyway (see next point).
  //   - Country of Residence, Nationality: these are dropdowns, and
  //     whether AskUni's dropdown widget is a plain <select> (safe with
  //     .selectOption()) or a custom searchable combobox (which
  //     .selectOption() would silently fail on) was never seen in the
  //     screenshots — same open question as the Gender dropdown in step
  //     01, so left unset here too rather than guess.
  //   - Passport Date of Issue: no matching column exists anywhere in
  //     the schema yet.
  //   - Need Visa: no matching column exists anywhere in the schema yet.
  const details = student.student_details || {};
  // 18 Sep 2026, eighth real test: switched every step-02 text field over
  // to smartFill() (defined above `fillAskUniApplication`) after Passport
  // Number failed with "element is not visible" for the full 60s timeout —
  // the same hidden-duplicate-field pattern as the Email bug, but this
  // time with no second candidate in the error log to disambiguate
  // against. smartFill tries every getByLabel match and uses the first
  // one that's actually visible, then falls back to the label's own text
  // position on the page if none are. This doesn't guarantee Passport
  // Number specifically now works — it's the best evidence-based hedge
  // available without a screenshot of the real form — so the next real
  // test's logs are still the thing to check.
  if(details.passport_number) await smartFill(page, "Passport Number", details.passport_number);
  // date_of_birth / passport_expiry come back from Supabase as plain
  // "YYYY-MM-DD" strings. These are "clearable date picker" fields, not
  // plain text — .fill() only works if the picker is backed by a real
  // typeable <input>, and the exact format it expects (YYYY-MM-DD vs
  // DD/MM/YYYY vs something else) was never confirmed in a screenshot.
  // Best-effort like step 03's document uploads: flag this as the first
  // thing to check if it throws, or if a real submission shows the wrong
  // date landed.
  if(details.date_of_birth) await smartFill(page, "Birth Date", details.date_of_birth);
  if(details.passport_expiry) await smartFill(page, "Passport Date of Expire", details.passport_expiry);
  if(details.city) await smartFill(page, "City of Residence", details.city);
  if(details.address_line) await smartFill(page, "Address", details.address_line);
  if(details.mother_name) await smartFill(page, "Mother Name", details.mother_name);
  if(details.father_name) await smartFill(page, "Father Name", details.father_name);
  await page.getByRole("button", { name: "Next" }).click();

  // ---- 03 Documents — best-effort, confirmed via a related page rather
  // than the wizard step itself. Nurudeen's completed student's own
  // profile page has an "Essential Documents" tab listing exactly four
  // upload slots: Passport, Diploma, Transcript, and a separate
  // "Profile Picture" button — those are very likely the same four
  // fields step 03 ("Add Documents") asks for while filling the wizard,
  // since it's the same underlying record, but that's an inference from
  // a different screen, not a screenshot of step 03 itself, so treat any
  // mismatch here as the first thing to check if this throws.
  const DOC_LABELS = { passport: "Passport", certificate: "Diploma", transcript: "Transcript" };
  for(const [kind, label] of Object.entries(DOC_LABELS)){
    const doc = findDoc(app_row, kind);
    if(doc) await trySetInputFiles(page, label, await downloadToTemp(doc.storage_path));
  }
  await page.getByRole("button", { name: "Next" }).click();

  return applyToProgramme(page, app_row, student, programme, university);
}

// ---- 04 Apply (confirmed for real, 17 Sep 2026, off Nurudeen's actual
// Usman Shehu Maisango application) ---------------------------------
async function applyToProgramme(page, app_row, student, programme, university){
  // The real placeholder text is "Type Interested Program and Press
  // Enter" — it does not contain the word "search", so a /search/i
  // selector (the original guess) would never have matched it.
  const searchBox = page.getByPlaceholder("Type Interested Program and Press Enter");
  await searchBox.fill(programme.course || "");
  await searchBox.press("Enter");

  // The result Nurudeen picked showed the course name, university and fee
  // together — matching on the course name is the most specific single
  // thing we know for sure is visible in a result row. Clicking it
  // expands the row rather than applying directly — it reveals a season
  // button (e.g. "2026 FALL (SEPTEMBER 2026)") that has to be clicked
  // next to actually trigger the confirmation dialog.
  await page.getByText(programme.course, { exact: false }).first().click();
  await page.getByRole("button", { name: /\b(20\d{2})\s+(FALL|SPRING|SUMMER|WINTER)\b/i }).first().click();

  const dialog = page.getByRole("dialog", { name: /are you sure/i });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole("button", { name: "APPLY" }).click();

  // "Application submit!" fires while STILL on the search/list page — the
  // programme is only added to the "Applications (Max 4)" panel on the
  // right at this point. The wizard isn't actually done, and the URL
  // hasn't changed yet, until the separate "FINISH" button is clicked.
  await page.getByText("Application submit!").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "FINISH" }).click();

  // Clicking FINISH is what redirects to the student's own profile page
  // at /users/student/<id>/applications/, with an "All steps are
  // completed!" toast — capture the id so a later response-check can go
  // straight there instead of matching by name.
  await page.waitForURL(/\/users\/student\/\d+\/applications\/?/, { timeout: 15000 });
  const match = page.url().match(/\/users\/student\/(\d+)\//);
  const askuniStudentId = match ? match[1] : null;

  await sb.from("applications").update({
    status: "sent_to_university",
    submitted_at: new Date().toISOString(),
    askuni_student_id: askuniStudentId,
    askuni_synced_at: new Date().toISOString(),
  }).eq("id", app_row.id);

  return { askuni_student_id: askuniStudentId, university: university.name, course: programme.course };
}

async function downloadToTemp(storagePath, bucket = "documents"){
  // documents.storage_path is a Supabase Storage path, not a local file —
  // Playwright's setInputFiles needs a real file on disk, so pull it down
  // to a throwaway path first. `bucket` defaults to "documents" (where
  // passport/transcript/certificate/birth_certificate really live) but a
  // profile photo lives in the separate "avatars" bucket — see the call
  // site above.
  const { data, error } = await sb.storage.from(bucket).download(storagePath);
  if(error) throw error;
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dest = path.join(os.tmpdir(), "askuni-" + Date.now() + "-" + path.basename(storagePath));
  await fs.writeFile(dest, Buffer.from(await data.arrayBuffer()));
  return dest;
}

async function readAskUniResponses(page){
  // Commissions table confirmed for real, 17 Sep 2026 — Usman Shehu
  // Maisango's own commission row ($349.60, 50%) showed up here right
  // after his application went in, alongside pre-existing rows. The
  // exact HTML markup of a row was never captured (no "Inspect Element"
  // screenshot), so rather than guess CSS classes, this reads the table
  // generically off its own header row — what was actually visible:
  // Student, Application Status, Giver, Taker, Commission %, Status,
  // Amount, Remaining.
  await page.goto(ASKUNI_PORTAL_URL + "/application/commissions/?only_my_commissions=true&activeTab=all");

  const table = page.locator("table").first();
  await table.waitFor({ timeout: 15000 });

  const headers = (await table.locator("thead th").allTextContents()).map(h => h.trim());
  const rows = await table.locator("tbody tr").all();

  const results = [];
  for(const row of rows){
    const cells = (await row.locator("td").allTextContents()).map(c => c.trim());
    const byHeader = {};
    headers.forEach((h, idx) => { byHeader[h] = cells[idx]; });

    const studentName = byHeader["Student"];
    if(!studentName) continue;
    const askuniStatus = byHeader["Application Status"];
    const amountRaw = (byHeader["Amount"] || "").replace(/[^0-9.]/g, "");
    const pctRaw = (byHeader["Commission %"] || byHeader["Commission"] || "").replace(/[^0-9.]/g, "");

    // Prefer matching by the AskUni student id we saved at submission time
    // (only true for applications submitted through applyToProgramme()
    // above, once 02/03 are unblocked); fall back to a name match against
    // our own profiles for anything submitted by hand before this existed.
    const [first, ...rest] = studentName.split(" ");
    const { data: matched } = await sb.from("applications")
      .select("id, profiles!inner(first_name, last_name)")
      .ilike("profiles.first_name", first)
      .ilike("profiles.last_name", rest.join(" ") || "%")
      .limit(1).maybeSingle();
    const applicationId = matched?.id || null;

    if(askuniStatus){
      results.push({ kind: "decision", application_id: applicationId, status: mapAskUniStatus(askuniStatus), student_name: studentName });
    }
    if(amountRaw){
      results.push({
        kind: "commission", application_id: applicationId, amount: parseFloat(amountRaw),
        currency: "USD", description: studentName + (pctRaw ? " (" + pctRaw + "%)" : ""),
      });
    }
  }
  return results;
}

// AskUni's own status text ("Offer Sent", "Declined/Rejected", ...) isn't
// one of our `applications.status` enum values (draft, submitted,
// in_review, docs_needed, sent_to_university, offer_received,
// offer_accepted, deposit_paid, visa_stage, enrolled, rejected,
// withdrawn) — only "Offer Sent" and "Declined/Rejected" have actually
// been seen on the real page so far, so only those two are mapped; an
// unrecognised status is stored as free text in `decision` (via the
// caller) rather than silently dropped or forced into the wrong enum
// value.
function mapAskUniStatus(askuniStatus){
  const s = askuniStatus.toLowerCase();
  if(s.includes("offer")) return "offer_received";
  if(s.includes("declin") || s.includes("reject")) return "rejected";
  return askuniStatus;
}

app.listen(PORT, () => console.log("askuni-bot listening on " + PORT));
