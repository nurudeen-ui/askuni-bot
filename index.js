// Orbuni ⇄ AskUni bot — starting skeleton. See README.md for the full
// story. This is deliberately small and readable rather than clever:
// Nurudeen is non-technical and will want to point at this file and
// ask "what does this part do" more than once.
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
const ASKUNI_PORTAL_URL = env("ASKUNI_PORTAL_URL", "https://www.askuni.com/login");

const bb = new Browserbase({ apiKey: env("BROWSERBASE_API_KEY", "") });
const BB_PROJECT_ID = env("BROWSERBASE_PROJECT_ID", "");

const sb = createClient(env("SUPABASE_URL", ""), env("SUPABASE_SERVICE_ROLE_KEY", ""));

const app = express();
app.use(express.json());

// A staff member should only ever be able to trigger this from inside
// the already-authenticated Orbuni team portal — this shared-secret
// check is a stand-in for wiring real auth through once this is
// actually deployed (e.g. verifying the same Supabase JWT the askuni
// edge function checks, via can_manage_section("applications")).
function requireInternalAuth(req, res, next){
  const got = req.headers["x-internal-secret"] || "";
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
  const { data } = await sb.from("integration_settings").select("value").eq("key", "askuni_context_id").maybeSingle();
  return data?.value || null;
}
async function saveContextId(id){
  await sb.from("integration_settings").upsert({ key: "askuni_context_id", value: id });
}

// ---- step 1: staff clicks "Send to AskUni" ------------------------------
// Returns a Live View URL. The portal shows this as "Click here to sign
// in to AskUni" — staff opens it, sees AskUni's REAL login page (this
// service never sees the password), logs in, and comes back.
app.post("/submissions", requireInternalAuth, async (req, res) => {
  try{
    const { application_id } = req.body || {};
    if(!application_id) return res.status(400).json({ error: "application_id required" });

    let contextId = await getSavedContextId();
    if(!contextId){
      const ctx = await bb.contexts.create({ projectId: BB_PROJECT_ID });
      contextId = ctx.id;
      await saveContextId(contextId);
    }

    const session = await bb.sessions.create({
      projectId: BB_PROJECT_ID,
      browserSettings: { context: { id: contextId, persist: true } },
    });
    const liveView = await bb.sessions.liveUrls.create(session.id);

    // Stash which application this session is for, so /submissions/:id/continue
    // (called once staff confirms they've logged in) knows what to do next.
    await sb.from("ai_actions").insert({
      section: "applications",
      action_type: "askuni_submission_started",
      proposal: { application_id, browserbase_session_id: session.id },
      summary: "Started an AskUni submission — waiting on manual login",
      created_by: req.body.staff_id || null,
    });

    res.json({ session_id: session.id, live_view_url: liveView.url, application_id });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// ---- step 2: staff clicks "I've logged in, continue" -------------------
app.post("/submissions/:sessionId/continue", requireInternalAuth, async (req, res) => {
  try{
    const { sessionId } = req.params;
    const { application_id } = req.body || {};

    const { data: app_row } = await sb.from("applications").select("*").eq("id", application_id).maybeSingle();
    if(!app_row) return res.status(404).json({ error: "application not found" });

    const browser = await chromium.connectOverCDP(
      `wss://connect.browserbase.com?apiKey=${env("BROWSERBASE_API_KEY","")}&sessionId=${sessionId}`
    );
    const page = browser.contexts()[0].pages()[0];

    const result = await fillAskUniApplication(page, app_row);
    await browser.close();

    res.json({ ok: true, result });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// ---- the scheduled half: check askuni.com for responses ----------------
// Point a Render Cron Job (or a periodic call from Supabase) at this.
// Reuses the saved context — no human needed, per Nurudeen's "keep it
// alive and automatically retrieve information" answer (17 Sep 2026).
app.post("/check-responses", requireInternalAuth, async (_req, res) => {
  try{
    const contextId = await getSavedContextId();
    if(!contextId) return res.status(409).json({ error: "no AskUni login saved yet — do one manual submission first" });

    const session = await bb.sessions.create({
      projectId: BB_PROJECT_ID,
      browserSettings: { context: { id: contextId, persist: true } },
    });
    const browser = await chromium.connectOverCDP(
      `wss://connect.browserbase.com?apiKey=${env("BROWSERBASE_API_KEY","")}&sessionId=${session.id}`
    );
    const page = browser.contexts()[0].pages()[0];
    const found = await readAskUniResponses(page);
    await browser.close();

    for(const item of found){
      if(item.kind === "decision"){
        await sb.from("applications").update({ status: item.status }).eq("id", item.application_id);
      }
      if(item.kind === "commission"){
        // Same shape the finance-write edge function expects for a manual
        // entry — kept consistent on purpose so a commission that arrives
        // via AskUni looks identical in the ledger to one typed by hand.
        await sb.from("finance_transactions").insert({
          kind: "income", direction: "in", amount: item.amount, currency: item.currency || "USD",
          partner_id: item.partner_id || null, description: "AskUni — " + item.description,
          occurred_on: new Date().toISOString().slice(0,10), source: "automatic",
        });
      }
    }
    res.json({ ok: true, found: found.length });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// ================= THE TWO FUNCTIONS THAT NEED ASKUNI'S REAL PAGE =======

async function fillAskUniApplication(page, applicationRow){
  // TODO — needs real askuni.com selectors. Sketch of the shape once we
  // have them:
  //   await page.goto(ASKUNI_PORTAL_URL + "/new-application");
  //   await page.fill("#student-name", applicationRow.student_name);
  //   await page.setInputFiles("#passport-upload", applicationRow.passport_file_path);
  //   ...
  //   await page.click("#submit");
  throw new Error("fillAskUniApplication() is a placeholder — needs askuni.com's real form fields before this can run for real");
}

async function readAskUniResponses(page){
  // TODO — needs to know what a decision/commission notice looks like
  // on askuni.com. Should return e.g.:
  //   [{ kind: "decision", application_id, status: "offer" }, ...]
  return [];
}

app.listen(PORT, () => console.log("askuni-bot listening on " + PORT));
