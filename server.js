// Orbuni ⇄ AskUni bot — version 3 (25 Sep 2026). See README.md.
//
// Version 3 runs its own browser on this Render server — no Browserbase, no
// monthly browser bill. It logs in to AskUni by itself with the email and
// password you keep in Render → askuni-bot → Environment (ASKUNI_EMAIL,
// ASKUNI_PASSWORD). Everything else from version 2 stays:
//  • every "Send to AskUni" is a tracked job (Supabase table askuni_submissions)
//    that the portal shows live, step by step;
//  • if AskUni refuses a step, the bot stops with AskUni's own words and a
//    picture of the AskUni screen, keeps the form open for a few minutes, and
//    "Carry on" (after fixing the student's details in Orbuni) resumes from
//    that step;
//  • the browser is always closed when a job ends.
// One student at a time: the server has 512 MB of memory, enough for one browser.

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";
import * as F from "./askuni-fill.js";
import * as P from "./preflight.js";
import { runScan } from "./scan.js";
import { runSync } from "./sync.js";

const env = (k, d) => process.env[k] ?? d;
const PORT = env("PORT", 3000);
const PORTAL = env("ASKUNI_PORTAL_URL", "https://apply.askuni.com");
const HOLD_MINUTES = Number(env("HOLD_MINUTES", "10"));        // how long a stopped form waits for "Carry on"
const ASKUNI_EMAIL = () => env("ASKUNI_EMAIL", "").trim();
const ASKUNI_PASSWORD = () => env("ASKUNI_PASSWORD", "");

const sb = createClient(env("SUPABASE_URL", ""), env("SUPABASE_SERVICE_ROLE_KEY", ""));
const app = express();
app.use(express.json());

function requireInternalAuth(req, res, next){
  const got = req.headers["x-internal-secret"] || "";   // header only: secrets in URLs end up in logs
  if(!process.env.INTERNAL_SHARED_SECRET || got !== process.env.INTERNAL_SHARED_SECRET) return res.status(401).json({ error: "not authorised" });
  next();
}

// ------------------------------------------------ the browser (one at a time)
// The AskUni login is kept in memory (cookies) between jobs while the server
// runs, so most sends skip the login; after a restart the bot simply logs in again.
let SAVED_LOGIN = null;
const LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--mute-audio",
  "--disable-extensions", "--disable-background-networking", "--renderer-process-limit=1", "--disable-features=Translate,MediaRouter"];
async function launch(){
  return chromium.launch({ headless: true, args: LAUNCH_ARGS, executablePath: env("CHROMIUM_PATH", "") || undefined });
}
async function newPage(browser){
  const context = await browser.newContext({ storageState: SAVED_LOGIN || undefined, viewport: { width: 1280, height: 900 }, locale: "en-US" });
  // pictures, fonts and videos aren't needed to fill a form — skipping them keeps memory low
  await context.route("**/*", (route) => ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue());
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  return { context, page };
}
async function ensureLogin(page, context, log){
  if(await F.isLoggedIn(page, PORTAL)) return;
  await F.login(page, PORTAL, ASKUNI_EMAIL(), ASKUNI_PASSWORD(), log);
  SAVED_LOGIN = await context.storageState().catch(() => null);
  if(!(await F.isLoggedIn(page, PORTAL))) throw new F.StepBlocked("login", [], "Logged in, but AskUni's student list didn't open.");
}

const LIVE = new Map(); // sessionId -> { browser, context, page, subId, applicationId, timer, busy }
let SEQ = 0;
async function openSession(subId, applicationId){
  const browser = await launch();
  const { context, page } = await newPage(browser);
  const sessionId = "local-" + Date.now().toString(36) + "-" + (++SEQ);
  const entry = { browser, context, page, subId, applicationId, busy: false, timer: null };
  LIVE.set(sessionId, entry);
  return { sessionId, ...entry };
}
function hold(sessionId){
  const e = LIVE.get(sessionId); if(!e) return;
  clearTimeout(e.timer);
  e.timer = setTimeout(() => closeSession(sessionId, "nobody pressed Carry on within " + HOLD_MINUTES + " minutes"), HOLD_MINUTES * 60 * 1000);
}
async function closeSession(sessionId, why){
  const e = LIVE.get(sessionId); if(!e) return;
  clearTimeout(e.timer); LIVE.delete(sessionId);
  try{ await e.browser.close(); }catch(_){}
  if(why && e.subId){
    const { data } = await sb.from("askuni_submissions").select("status").eq("id", e.subId).maybeSingle();
    if(data && ["starting", "waiting_login", "filling", "needs_you"].includes(data.status))
      await track(e.subId, { status: "failed", message: "The AskUni form closed (" + why + ") before it finished. Press Send to AskUni again." });
  }
  console.log("[session] closed " + sessionId + (why ? " — " + why : ""));
}
// Only one browser fits in memory. A form that is only waiting for "Carry on"
// gives way to a new send; one that is busy filling does not.
async function makeRoom(){
  for(const [id, e] of LIVE){
    if(e.busy) return false;
    await closeSession(id, "closed to make room for another student");
  }
  return true;
}

// ------------------------------------------------ job tracking
const LOGS = new Map(); // subId -> recent progress lines (kept in memory, written whole)
async function track(subId, patch, line){
  if(!subId) return;
  const upd = { ...patch, updated_at: new Date().toISOString() };
  if(line){
    const list = LOGS.get(subId) || [];
    list.push({ at: new Date().toISOString(), ...line });
    LOGS.set(subId, list.slice(-120));
    upd.log = LOGS.get(subId);
  }
  const { error } = await sb.from("askuni_submissions").update(upd).eq("id", subId);
  if(error) console.error("[track] " + error.message);
}
// A picture of the AskUni screen for the portal (private storage + a link that works for 2 hours).
// These can show a student's personal details, so they are deleted when the job
// ends well or is cancelled, and anything left over is swept away after a day.
const SHOTS = new Map(); // subId -> [paths]
async function dropShots(subId){
  const paths = SHOTS.get(subId) || []; SHOTS.delete(subId);
  if(paths.length) await sb.storage.from("chat").remove(paths).catch(() => {});
  if(subId) await sb.from("askuni_submissions").update({ screenshot_url: null, screenshot_path: null }).eq("id", subId).then(() => {}, () => {});
}
async function sweepShots(){
  try{
    const { data } = await sb.storage.from("chat").list("askuni-debug", { limit: 1000 });
    const old = (data || []).filter(f => f.name && Date.now() - Date.parse(f.created_at || 0) > 24 * 3600e3).map(f => "askuni-debug/" + f.name);
    if(old.length) await sb.storage.from("chat").remove(old);
  }catch(_){}
}
setInterval(sweepShots, 3600e3); setTimeout(sweepShots, 60e3);
async function screenshot(page, label, subId){
  try{
    const buf = await page.screenshot({ fullPage: false });
    const path = "askuni-debug/" + Date.now() + "-" + label.replace(/[^a-z0-9]+/gi, "-") + ".png";
    const up = await sb.storage.from("chat").upload(path, buf, { contentType: "image/png" });
    if(up.error) return {};
    if(subId){ const l = SHOTS.get(subId) || []; l.push(path); SHOTS.set(subId, l); }
    const signed = await sb.storage.from("chat").createSignedUrl(path, 7200);
    return { screenshot_path: path, screenshot_url: signed.data ? signed.data.signedUrl : null };
  }catch(_){ return {}; }
}

// ------------------------------------------------ everything AskUni needs, from Orbuni
async function loadApplication(applicationId){
  const { data: row, error } = await sb.from("applications")
    .select("*, profiles(*, student_details(*)), programmes(*, universities(*))").eq("id", applicationId).maybeSingle();
  if(error) throw error;
  if(!row) return null;
  const { data: docs } = await sb.from("documents").select("*").eq("profile_id", row.profile_id).in("status", ["verified", "uploaded"]);
  return { ...row, documents: docs || [] };
}
function pickDoc(row, kinds){
  const list = (row.documents || []).filter(d => kinds.includes(d.kind));
  return list.find(d => d.status === "verified") || list[0] || null;
}
async function downloadToTemp(storagePath, bucket = "documents"){
  const { data, error } = await sb.storage.from(bucket).download(storagePath);
  if(error) throw new Error("couldn't download " + storagePath + " from " + bucket + ": " + error.message);
  const fs = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
  const dest = path.join(os.tmpdir(), "askuni-" + Date.now() + "-" + path.basename(storagePath));
  await fs.writeFile(dest, Buffer.from(await data.arrayBuffer()));
  return dest;
}
async function prepare(row){
  const p = row.profiles || {}, d = p.student_details || {}, prog = row.programmes || {}, uni = prog.universities || {};
  const files = {}, fileProblems = {};
  // remembers why a file is absent ("missing", or the download error) so the checks can say so plainly
  const grab = async (key, storagePath, bucket) => {
    if(!storagePath){ if(!fileProblems[key]) fileProblems[key] = "missing"; return; }
    try{ files[key] = await downloadToTemp(storagePath, bucket); delete fileProblems[key]; }
    catch(e){ fileProblems[key] = String(e && e.message || e).split("\n")[0].slice(0, 120); }
  };
  const photo = pickDoc(row, ["profile_photo"]);
  await grab("photo", photo && photo.storage_path, "avatars");
  if(!files.photo && p.photo_path) await grab("photo", p.photo_path, "avatars");
  const pass = pickDoc(row, ["passport"]); await grab("passport", pass && pass.storage_path);
  const dip = pickDoc(row, ["certificate", "diploma"]); await grab("diploma", dip && dip.storage_path);
  const tr = pickDoc(row, ["transcript"]); await grab("transcript", tr && tr.storage_path);
  return {
    first_name: p.first_name, last_name: p.last_name, email: p.email, gender: (p.gender || "").toLowerCase() || null,
    phone: p.phone || p.whatsapp,
    passport_number: d.passport_number, date_of_birth: d.date_of_birth, nationality: d.nationality, country: d.country,
    country_of_birth: d.country_of_birth, city: d.city, address_line: d.address_line, mother_name: d.mother_name,
    father_name: d.father_name, passport_expiry: d.passport_expiry, passport_issue_date: d.passport_issue_date,
    course: prog.course, university: uni.name, files, fileProblems,
  };
}
async function cleanupFiles(data){
  const fs = await import("node:fs/promises");
  for(const f of Object.values((data && data.files) || {})) if(f) await fs.unlink(f).catch(() => {});
}

// ------------------------------------------------ the job itself (runs in the background)
async function runJob(sessionId, subId, applicationId){
  const e = LIVE.get(sessionId);
  if(!e) return track(subId, { status: "failed", message: "The AskUni form had already closed. Press Send to AskUni again." });
  if(e.busy) return;
  e.busy = true; clearTimeout(e.timer);
  const page = e.page;
  const log = (level, text) => { console.log("[job " + subId.slice(0, 8) + "] " + text); track(subId, {}, { level, text }); };
  let data = null;
  let reached = 0;   // highest form step started; from step 2 on, AskUni already has the student's account
  const onStep = (n, name) => { reached = Math.max(reached, n); return track(subId, { step: name, message: "On " + name + "…" }); };
  try{
    await track(subId, { status: "filling", message: "Checking the student's details and documents…", missing: [], screenshot_url: null });
    const row = await loadApplication(applicationId);   // fresh every time, so fixes made in Orbuni are picked up
    if(!row) throw new Error("This application no longer exists in Orbuni.");
    data = await prepare(row);
    // Check everything before typing into AskUni, so a send that would fail halfway never creates an AskUni account.
    const stepNow = await F.currentStep(page);
    reached = stepNow;
    const check = await P.preflight(data, stepNow);
    for(const w of check.warnings) log("warn", "check: " + w);
    if(check.blockers.length){
      const msg = "Fix these in Orbuni first: " + check.blockers.join("; ") + ".";
      // not started yet: nothing exists in AskUni, so just stop; halfway: keep the form open for Carry on
      if(!stepNow) throw new Error("Nothing was sent to AskUni. " + msg);
      throw new F.StepBlocked("checks", check.blockers.map(b => ({ field: "Orbuni", message: b })), msg);
    }
    await track(subId, { message: "Logging in to AskUni…" });
    await ensureLogin(page, e.context, log);
    await track(subId, { message: "Filling in AskUni's form…" });
    if(!(await F.currentStep(page))) await F.openWizard(page, PORTAL, log);
    let out;
    try{
      out = await F.runWizard(page, data, log, onStep);
    }catch(err){
      if(!(err instanceof F.StepBlocked) || err.step !== "login") throw err;
      SAVED_LOGIN = null;
      // Starting the form again would create a second AskUni student once step 1 was accepted.
      if(reached >= 2) throw new Error("AskUni signed the bot out after this student's AskUni account was already created, so the bot stopped instead of starting again (that would make a second AskUni student). Finish this student by hand in AskUni — don't press Send to AskUni again for them.");
      // Still on step 1: nothing exists in AskUni yet, so log in again once and start the form again.
      log("warn", "AskUni asked to log in again");
      await ensureLogin(page, e.context, log);
      await F.openWizard(page, PORTAL, log);
      out = await F.runWizard(page, data, log, onStep);
    }
    await sb.from("applications").update({
      status: "sent_to_university", submitted_at: new Date().toISOString(),
      askuni_student_id: out.askuni_student_id, askuni_synced_at: new Date().toISOString(),
    }).eq("id", applicationId);
    await track(subId, { status: "submitted", step: "done", askuni_student_id: out.askuni_student_id,
      message: "Submitted — " + (data.course || "the programme") + (data.university ? " at " + data.university : "") + (out.askuni_student_id ? " (AskUni student #" + out.askuni_student_id + ")" : "") + "." },
      { level: "info", text: "finished" });
    await dropShots(subId);
    await closeSession(sessionId);
  }catch(err){
    const shot = await screenshot(page, "job-" + subId.slice(0, 8), subId);
    const msg = String(err && err.message || err).split("\n")[0];
    if(err instanceof F.StepBlocked && err.step !== "login" && err.step !== "start"){
      // keep the form open so a person can fix the student's details in Orbuni and carry on
      await track(subId, { status: "needs_you", step: err.step, missing: err.missing, ...shot,
        message: err.message + " — fix it in the student's details, then press Carry on (the form waits " + HOLD_MINUTES + " minutes)." }, { level: "warn", text: err.message });
      hold(sessionId);
    }else{
      await track(subId, { status: "failed", ...shot, message: (err instanceof F.StepBlocked ? "" : "Stopped: ") + msg }, { level: "error", text: msg });
      await closeSession(sessionId);
    }
  }finally{
    await cleanupFiles(data);
    const still = LIVE.get(sessionId); if(still) still.busy = false;
  }
}

// ------------------------------------------------ routes
app.get("/", (_req, res) => res.json({ ok: true, service: "askuni-bot", version: 3 }));

app.get("/diagnostics", requireInternalAuth, async (_req, res) => {
  const out = { version: 3, askuni_login_set: !!(ASKUNI_EMAIL() && ASKUNI_PASSWORD()), browser: "unknown", supabase: "unknown", open_forms: LIVE.size,
    memory_mb: Math.round(process.memoryUsage().rss / 1048576) };
  try{ const t = Date.now(); const b = await launch(); out.browser = "ok (" + (Date.now() - t) + " ms, " + b.version() + ")"; await b.close(); }
  catch(e){ out.browser = "failed: " + String(e && e.message || e).split("\n")[0]; }
  try{ const { error } = await sb.from("applications").select("id").limit(1); out.supabase = error ? "failed: " + error.message : "ok"; }catch(e){ out.supabase = "failed: " + String(e.message || e); }
  res.json(out);
});

// Start: opens the browser and starts filling straight away (the bot logs in itself).
app.post("/submissions", requireInternalAuth, async (req, res) => {
  const application_id = req.body && req.body.application_id;
  if(!application_id) return res.status(400).json({ error: "application_id required" });
  if(!(await makeRoom())) return res.status(409).json({ error: "The AskUni helper is busy sending another student — try again in a minute." });
  const ins = await sb.from("askuni_submissions").insert({ application_id, status: "starting", message: "Opening AskUni…", created_by: req.body.staff_id || null }).select("id").single();
  if(ins.error) return res.status(500).json({ error: "couldn't record the job: " + ins.error.message });
  const subId = ins.data.id;
  let s;
  try{
    s = await openSession(subId, application_id);
  }catch(e){
    const friendly = "Couldn't start the browser for AskUni: " + String(e && e.message || e).split("\n")[0];
    await track(subId, { status: "failed", message: friendly });
    return res.status(502).json({ error: friendly, submission_id: subId });
  }
  await track(subId, { session_id: s.sessionId, live_view_url: null, live_view_embed_url: null });
  res.json({ submission_id: subId, session_id: s.sessionId, needs_login: false });
  runJob(s.sessionId, subId, application_id);
});

// Carry on: after someone fixed the student's details in Orbuni.
app.post("/submissions/:sessionId/continue", requireInternalAuth, async (req, res) => {
  const { sessionId } = req.params;
  const { submission_id } = req.body || {};
  const e = LIVE.get(sessionId);
  if(!e){
    if(submission_id) await track(submission_id, { status: "failed", message: "The AskUni form had already closed (it waits " + HOLD_MINUTES + " minutes). Press Send to AskUni again." });
    return res.status(410).json({ error: "That AskUni form has closed — press Send to AskUni again." });
  }
  if(e.busy) return res.status(409).json({ error: "Already working on it — watch the progress in the card." });
  res.status(202).json({ ok: true, submission_id: submission_id || e.subId });
  runJob(sessionId, submission_id || e.subId, (req.body && req.body.application_id) || e.applicationId);
});

app.post("/submissions/:sessionId/cancel", requireInternalAuth, async (req, res) => {
  const e = LIVE.get(req.params.sessionId);
  const subId = (req.body && req.body.submission_id) || (e && e.subId);
  await closeSession(req.params.sessionId);
  if(subId){ await track(subId, { status: "cancelled", message: "Cancelled." }); await dropShots(subId); }
  res.json({ ok: true });
});

// Dry run: what a send WOULD do for one application, without typing anything into AskUni.
// Reads the student from Orbuni, downloads and checks the documents, and returns the step-by-step
// plan with "ready / missing / problem" for each field (never the values themselves).
// { application_id, check_login: true } also logs in to AskUni and opens the student list —
// read only, no form is opened — to prove the AskUni login works.
app.post("/dry-run", requireInternalAuth, async (req, res) => {
  const application_id = req.body && req.body.application_id;
  if(!application_id) return res.status(400).json({ error: "application_id required" });
  let data = null;
  try{
    const row = await loadApplication(application_id);
    if(!row) return res.status(404).json({ error: "No Orbuni application with that id." });
    data = await prepare(row);
    const report = await P.preflight(data, 0);
    report.application_id = application_id;
    report.would_send = report.ok ? "yes — every required item is there" : "no — the send would stop with: " + report.blockers.join("; ");
    if(req.body.check_login){
      if(LIVE.size || SCANNING) report.askuni_login = "not checked: the bot is busy (a send or the 15-minute sync is running) — try again in a few minutes";
      else{
        SCANNING = true; let browser = null;   // keeps the timed sync from starting a second browser meanwhile
        try{
          browser = await launch();
          const { context, page } = await newPage(browser);
          await ensureLogin(page, context, () => {});
          report.askuni_login = "ok — logged in and the student list opened";
        }catch(e){ report.askuni_login = "failed: " + String(e && e.message || e).split("\n")[0]; }
        finally{ if(browser){ try{ await browser.close(); }catch(_){} } SCANNING = false; }
      }
    }
    report.not_done = "Dry run: nothing was typed into AskUni and nothing was submitted.";
    console.log("[dry-run] " + application_id.slice(0, 8) + " — " + report.would_send);
    for(const line of P.planSummary(report)) console.log("[dry-run]   " + line);
    res.json(report);
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e).split("\n")[0] });
  }finally{
    await cleanupFiles(data);
  }
});

// Check AskUni for decisions and commissions.
app.post("/check-responses", requireInternalAuth, async (_req, res) => {
  if(!(await makeRoom())) return res.status(409).json({ error: "The AskUni helper is busy sending a student — try again in a minute." });
  let browser = null;
  try{
    browser = await launch();
    const { context, page } = await newPage(browser);
    await ensureLogin(page, context, () => {});
    await page.goto(PORTAL + "/application/commissions/?only_my_commissions=true&activeTab=all", { waitUntil: "domcontentloaded", timeout: 30000 });
    const found = await readAskUniResponses(page);
    let written = 0;
    for(const item of found){
      if(item.kind === "decision" && item.application_id){
        const patch = { decision: item.status, decision_at: new Date().toISOString(), askuni_synced_at: new Date().toISOString() };
        if(["offer_received", "rejected"].includes(item.status)) patch.status = item.status;
        await sb.from("applications").update(patch).eq("id", item.application_id); written++;
      }
      if(item.kind === "commission"){
        const desc = "AskUni — " + item.description;
        const { data: exists } = await sb.from("finance_transactions").select("id").eq("description", desc).eq("amount", item.amount).limit(1);
        if(!exists || !exists.length){
          await sb.from("finance_transactions").insert({ kind: "income", direction: "in", amount: item.amount, currency: item.currency || "USD",
            application_id: item.application_id || null, description: desc, occurred_on: new Date().toISOString().slice(0, 10), source: "automatic" });
          written++;
        }
      }
    }
    res.json({ ok: true, found: found.length, new: written });
  }catch(e){
    console.error("[check-responses] FAILED: " + String(e && e.stack || e));
    res.status(500).json({ error: String(e && e.message || e).split("\n")[0] });
  }finally{
    if(browser){ try{ await browser.close(); }catch(_){} }
  }
});

async function readAskUniResponses(page){
  // The commissions list may be a real <table> or a grid of rows; wait for either.
  const table = page.locator("table").first();
  const grid = page.locator("[role=grid], [role=table]").first();
  await Promise.race([table.waitFor({ timeout: 25000 }), grid.waitFor({ timeout: 25000 })]).catch(() => {});
  const useTable = await table.count();
  const root = useTable ? table : grid;
  if(!(await root.count())) return [];
  const headers = (await root.locator(useTable ? "thead th" : "[role=columnheader]").allTextContents()).map(h => h.trim());
  const rows = await root.locator(useTable ? "tbody tr" : "[role=row]:has([role=cell])").all();
  const results = [];
  for(const row of rows){
    const cells = (await row.locator(useTable ? "td" : "[role=cell]").allTextContents()).map(c => c.trim());
    const by = {}; headers.forEach((h, i) => { by[h] = cells[i]; });
    const studentName = by["Student"]; if(!studentName) continue;
    const st = by["Application Status"];
    const amountRaw = (by["Amount"] || "").replace(/[^0-9.]/g, "");
    const pctRaw = (by["Commission %"] || by["Commission"] || "").replace(/[^0-9.]/g, "");
    // match the student by BOTH names exactly (a one-word name is not enough to be sure)
    const [first, ...rest] = studentName.trim().split(/\s+/);
    let application_id = null;
    if(first && rest.length){
      const { data: matched } = await sb.from("applications").select("id, profiles!inner(first_name, last_name)")
        .ilike("profiles.first_name", first).ilike("profiles.last_name", rest.join(" ")).limit(2);
      if(matched && matched.length === 1) application_id = matched[0].id;
    }
    if(st) results.push({ kind: "decision", application_id, status: mapStatus(st) });
    if(amountRaw) results.push({ kind: "commission", application_id, amount: parseFloat(amountRaw), currency: "USD", description: studentName + (pctRaw ? " (" + pctRaw + "%)" : "") });
  }
  return results;
}
function mapStatus(s){
  const t = s.toLowerCase();
  if(t.includes("offer")) return "offer_received";
  if(t.includes("declin") || t.includes("reject")) return "rejected";
  return s;
}

// ------------------------------------------------ reading AskUni on a timer (read only)
// Every SCAN_MINUTES (default 15) the bot opens AskUni, reads the student list, applications,
// commissions and menu pages, and keeps the raw text in askuni_scans. It never clicks Save,
// Apply or Delete, and it steps aside whenever a student is being sent.
const SCAN_MINUTES = Number(env("SCAN_MINUTES", "15"));
let SCANNING = false;
let LAST_DISCOVERY = 0;
async function scanNow(){
  if(SCANNING) return { skipped: "already reading AskUni" };
  if(LIVE.size) return { skipped: "a student is being sent" };
  SCANNING = true; let browser = null;
  try{
    browser = await launch();
    const { context, page } = await newPage(browser);
    await ensureLogin(page, context, () => {});
    const log = (lvl, t) => console.log("[sync] " + t);
    const stats = await runSync(page, PORTAL, sb, log);
    // the page-recording scan is only for discovery: once after start, then once a day
    let n = 0;
    if(Date.now() - LAST_DISCOVERY > 24 * 3600e3){ n = await runScan(page, PORTAL, sb, log); LAST_DISCOVERY = Date.now(); }
    return { ok: true, sync: stats, pages: n };
  }catch(e){
    console.error("[scan] FAILED: " + String(e && e.message || e).split("\n")[0]);
    return { error: String(e && e.message || e).split("\n")[0] };
  }finally{
    if(browser){ try{ await browser.close(); }catch(_){} }
    SCANNING = false;
  }
}
if(env("AUTO_SCAN", "on") !== "off"){ setTimeout(scanNow, 90e3); setInterval(scanNow, SCAN_MINUTES * 60e3); }
app.post("/scan", requireInternalAuth, async (_req, res) => res.json(await scanNow()));

app.listen(PORT, () => console.log("askuni-bot v3 listening on " + PORT + " — AskUni login " + (ASKUNI_EMAIL() && ASKUNI_PASSWORD() ? "set" : "NOT set")));
