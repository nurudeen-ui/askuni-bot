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
//   02 Student Information — still blocked, see fillAskUniApplication().
//   03 Documents — still blocked, see fillAskUniApplication().
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

// ---- loading one Orbuni application with everything the wizard needs ---
// Real schema, checked directly against Supabase 17 Sep 2026 — this
// replaces the earlier version of this file, which guessed at flat
// columns (first_name, email, passport_file_path...) that don't actually
// exist on `applications`. The real shape: `applications` only holds
// profile_id + programme_id + status; the student's own details live on
// `profiles`, the programme/university on `programmes`/`universities`,
// and uploaded files on `documents` (one row per file, keyed by
// profile_id + a `kind` enum).
async function loadApplication(applicationId){
  const { data: appRow, error } = await sb.from("applications")
    .select("*, profiles(*), programmes(*, universities(*))")
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
app.post("/submissions", requireInternalAuth, async (req, res) => {
  try{
    const { application_id } = req.body || {};
    if(!application_id) return res.status(400).json({ error: "application_id required" });

    let contextId = await getSavedContextId();
    if(!contextId){
      const ctx = await bb.contexts.create({ name: "orbuni-askuni" });
      contextId = ctx.id;
      await saveContextId(contextId);
    }

    const session = await bb.sessions.create({
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

    const app_row = await loadApplication(application_id);
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
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// ================= THE FUNCTIONS THAT NEED ASKUNI'S REAL PAGE ===========

async function fillAskUniApplication(page, app_row){
  const student = app_row.profiles || {};
  const programme = app_row.programmes || {};
  const university = programme.universities || {};

  await page.goto(ASKUNI_PORTAL_URL + "/users/student/list/");

  // Opening the wizard: confirmed from Nurudeen's screenshots that it's a
  // modal titled "Add Student User" — the button that opens it wasn't
  // itself screenshotted, so "add student" is a best-guess match on a
  // real modal title rather than a guessed button label from nothing.
  await page.getByRole("button", { name: /add student/i }).click();

  // ---- 01 Account Details (confirmed) ----
  await page.getByLabel("First Name").fill(student.first_name || "");
  await page.getByLabel("Last Name").fill(student.last_name || "");
  await page.getByLabel("Email").fill(student.email || "");
  // Gender is a dropdown — real option values not yet seen, so this is
  // left unset for now rather than guessing wrong ones:
  // await page.getByLabel("Gender").selectOption(...);
  // Mobile Phone has a separate country-code picker defaulted to +90
  // (Turkey) — the picker's real interaction (dropdown vs typeahead)
  // hasn't been seen, so this is also left unset for now:
  // await page.getByLabel("Mobile Phone").fill(student.phone || "");
  const profilePhoto = findDoc(app_row, "profile_photo");
  if(profilePhoto){
    await page.getByLabel("Profile Picture").setInputFiles(await downloadToTemp(profilePhoto.storage_path));
  }
  await page.getByRole("button", { name: "Next" }).click();

  // ---- 02 Student Information / 03 Documents — STILL BLOCKED ----
  // Nurudeen's screenshots covered the whole application end to end, but
  // the images themselves didn't carry over into this working session —
  // only a written description of the overall flow did, and that
  // description doesn't include the exact field labels for these two
  // steps. Steps 01 and 04 are confirmed enough to write for real; these
  // two aren't, and guessing field labels here (unlike a page's general
  // layout) is exactly the kind of mistake that silently fills in the
  // wrong field on a real student's real application.
  //
  // What's actually needed to finish this — and only this, nothing more:
  // one screenshot each of "02 Student Information" and "03 Documents"
  // while they're mid-fill, so the field labels and upload buttons are
  // visible. Once those two exist, delete this throw and the two
  // TODO steps below can be written the same way step 01 was.
  throw new Error(
    "fillAskUniApplication() has steps 01 and 04 written, but 02 (Student " +
    "Information) and 03 (Documents) still need their field labels — send " +
    "one screenshot of each of those two steps, mid-fill, and this can be finished."
  );

  // TODO 02 Student Information — fields unknown.

  // TODO 03 Documents — AskUni's own screenshots showed "Essential
  // Documents" / "Other Documents" tabs. Our own `documents.kind` enum
  // (passport, passport_photo, certificate, transcript, english_test,
  // birth_certificate, other, ...) lines up well enough with that split
  // to guess which of our files are "essential" — but not the exact
  // upload button/label for each one on AskUni's side, so this stays a
  // TODO alongside 02:
  // const essential = ["passport", "passport_photo", "certificate", "transcript", "english_test"];
  // for(const kind of essential){
  //   const doc = findDoc(app_row, kind);
  //   if(doc) await page.getByLabel(/* AskUni's real label for `kind` */).setInputFiles(await downloadToTemp(doc.storage_path));
  // }

  return applyToProgramme(page, app_row, student, programme, university);
}

// ---- 04 Apply (confirmed for real, 17 Sep 2026) ------------------------
async function applyToProgramme(page, app_row, student, programme, university){
  await page.getByPlaceholder(/search/i).fill(programme.course || "");

  // The result Nurudeen picked showed the course name, university and fee
  // together — matching on the course name is the most specific single
  // thing we know for sure is visible in a result row.
  await page.getByText(programme.course, { exact: false }).first().click();

  const dialog = page.getByRole("dialog", { name: /are you sure/i });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole("button", { name: "APPLY" }).click();

  await page.getByText("Application submit!").waitFor({ timeout: 15000 });

  // The successful submit redirects to the student's own profile page at
  // /users/student/<id>/applications/ — capture that id so a later
  // response-check can go straight there instead of matching by name.
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

async function downloadToTemp(storagePath){
  // documents.storage_path is a Supabase Storage path, not a local file —
  // Playwright's setInputFiles needs a real file on disk, so pull it down
  // to a throwaway path first.
  const { data, error } = await sb.storage.from("documents").download(storagePath);
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
