// Orbuni ⇄ AskUni — the part that actually fills AskUni's "Add Student User"
// wizard. Kept separate from the web server (index.js) so it can be tested
// against a local copy of the wizard without touching the real site.
//
// WHY THIS WAS REWRITTEN (24 Sep 2026)
// ------------------------------------
// The 20 Sep attempt's own screenshot, read back from storage, showed the
// wizard never left step 01: AskUni put "This field is required" under
// Gender and Mobile Phone, so "Next" did nothing. Every step-02 field then
// "wasn't visible" (it had never been drawn), the documents went nowhere,
// and the programme search box was never there — a whole minute of
// timeouts caused by two empty required fields in step 01.
//
// So this version:
//   1. fills Gender (a dropdown) and Mobile Phone (a flag + number box);
//   2. after every "Next", CHECKS the next step really appeared — and if
//      it didn't, reads AskUni's own red error messages and stops there
//      with a plain list of what AskUni wants, instead of carrying on
//      blind;
//   3. handles dropdowns (Gender, Country of Birth, Country of Residence,
//      Nationality), date pickers (reads the box's own placeholder to get
//      the date format right) and file uploads (works even when AskUni
//      hides the real file input behind a button);
//   4. can pick up from whatever step the page is on — so if a person
//      fixes one field by hand in the live view, "Carry on" resumes from
//      there instead of starting over.

// ---------------------------------------------------------------- errors
export class StepBlocked extends Error{
  constructor(step, missing, message){
    super(message || ("AskUni didn't move past " + step));
    this.step = step; this.missing = missing || [];
  }
}

const STEP_NAMES = ["", "01 Account Details", "02 Student Information", "03 Documents", "04 Apply"];
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Nationalities Orbuni stores as a word ("Nigerian") while AskUni's list is
// countries ("Nigeria"). Unknown words are tried as-is.
const DEMONYM = {
  nigerian:"Nigeria", ghanaian:"Ghana", cameroonian:"Cameroon", kenyan:"Kenya", ugandan:"Uganda", tanzanian:"Tanzania",
  ethiopian:"Ethiopia", somali:"Somalia", sudanese:"Sudan", egyptian:"Egypt", moroccan:"Morocco", algerian:"Algeria",
  tunisian:"Tunisia", libyan:"Libya", senegalese:"Senegal", ivorian:"Cote d'Ivoire", malian:"Mali", nigerien:"Niger",
  chadian:"Chad", gambian:"Gambia", "sierra leonean":"Sierra Leone", liberian:"Liberia", guinean:"Guinea", togolese:"Togo",
  beninese:"Benin", burkinabe:"Burkina Faso", zambian:"Zambia", zimbabwean:"Zimbabwe", malawian:"Malawi", rwandan:"Rwanda",
  burundian:"Burundi", congolese:"Congo", angolan:"Angola", mozambican:"Mozambique", "south african":"South Africa",
  namibian:"Namibia", botswanan:"Botswana", pakistani:"Pakistan", indian:"India", bangladeshi:"Bangladesh", afghan:"Afghanistan",
  iranian:"Iran", iraqi:"Iraq", syrian:"Syria", jordanian:"Jordan", lebanese:"Lebanon", palestinian:"Palestine", yemeni:"Yemen",
  saudi:"Saudi Arabia", emirati:"United Arab Emirates", turkish:"Turkey", azerbaijani:"Azerbaijan", kazakh:"Kazakhstan",
  uzbek:"Uzbekistan", turkmen:"Turkmenistan", kyrgyz:"Kyrgyzstan", tajik:"Tajikistan", indonesian:"Indonesia",
  malaysian:"Malaysia", filipino:"Philippines", british:"United Kingdom", american:"United States", russian:"Russia"
};
export function countryName(v){
  const k = norm(v);
  return DEMONYM[k] || (v ? String(v).trim() : "");
}
function countryAliases(c){
  const k = norm(c);
  const out = [c];
  if(k === "turkey" || k === "türkiye" || k === "turkiye") out.push("Turkey", "Türkiye", "Turkiye");
  if(k === "cote d'ivoire") out.push("Côte d'Ivoire", "Ivory Coast");
  if(k === "united states") out.push("United States of America", "USA");
  if(k === "united kingdom") out.push("UK", "Great Britain");
  if(k === "congo") out.push("Congo (Kinshasa)", "Democratic Republic of the Congo", "Congo, The Democratic Republic of the");
  return out;
}

// ------------------------------------------------------------ locating
// The open wizard is a dialog; everything is looked up inside it so a
// same-named field elsewhere on the page (AskUni's own search boxes) can
// never be picked by mistake — the bug behind the old Email failure.
export function wizard(page){
  return page.locator('[role="dialog"]').filter({ has: page.locator("input, [role=combobox], [aria-haspopup]") }).last();
}
async function scopeOf(page){
  const w = wizard(page);
  return (await w.count()) ? w : page.locator("body");
}
// The block of the form that belongs to one label: the label itself, then
// the nearest ancestor that also holds a control.
function labelLocator(scope, label){
  const re = new RegExp("^\\s*" + esc(label) + "\\s*\\*?\\s*$", "i");
  return scope.locator("label, legend, p, span, div, h6").filter({ hasText: re });
}
async function fieldBox(scope, label){
  const lab = labelLocator(scope, label);
  const n = await lab.count();
  for(let i = 0; i < n; i++){
    const l = lab.nth(i);
    if(!(await l.isVisible().catch(() => false))) continue;
    const box = l.locator("xpath=ancestor-or-self::*[.//input or .//select or .//textarea or .//*[@role='combobox'] or .//*[@aria-haspopup]][1]");
    if(await box.count()) return box.first();
  }
  return null;
}
async function firstVisible(loc){
  const n = await loc.count();
  for(let i = 0; i < n; i++){ const el = loc.nth(i); if(await el.isVisible().catch(() => false)) return el; }
  return null;
}

// ------------------------------------------------------------ text boxes
export async function fillText(page, label, value, log){
  if(value == null || value === "") return { ok:false, reason:"no value in Orbuni" };
  const scope = await scopeOf(page);
  let el = await firstVisible(scope.getByLabel(new RegExp("^\\s*" + esc(label) + "\\s*\\*?\\s*$", "i")));
  if(!el){ const box = await fieldBox(scope, label); if(box) el = await firstVisible(box.locator("input:not([type=hidden]):not([type=file]), textarea")); }
  if(!el){ log && log("warn", `${label}: box not found`); return { ok:false, reason:"box not found" }; }
  await el.fill(String(value), { timeout: 8000 });
  log && log("info", `${label}: filled`);
  return { ok:true };
}

// ------------------------------------------------------------ dropdowns
// Works for a plain <select>, a MUI Select (click → pick from a list) and a
// MUI Autocomplete (type → pick). `wanted` is a list of acceptable texts.
export async function pickOption(page, label, wanted, log){
  wanted = (Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean);
  if(!wanted.length) return { ok:false, reason:"no value in Orbuni" };
  const scope = await scopeOf(page);
  const box = await fieldBox(scope, label);
  if(!box){ log && log("warn", `${label}: dropdown not found`); return { ok:false, reason:"dropdown not found" }; }

  const sel = box.locator("select");
  if(await sel.count()){
    const opts = await sel.first().locator("option").allTextContents();
    const hit = bestMatch(opts, wanted);
    if(hit != null){ await sel.first().selectOption({ label: hit }); log && log("info", `${label}: chose "${hit}"`); return { ok:true, chose:hit }; }
  }

  const control = await firstVisible(box.locator("[role=combobox], [aria-haspopup=listbox], input:not([type=hidden]):not([type=file])"));
  if(!control){ log && log("warn", `${label}: no clickable control`); return { ok:false, reason:"no control" }; }
  await control.click({ timeout: 8000 });
  const typeable = await control.evaluate(e => e.tagName === "INPUT" && !e.readOnly).catch(() => false);
  if(typeable){ await control.fill(""); await control.pressSequentially(wanted[0].slice(0, 24), { delay: 25 }); }

  const options = page.locator('[role=option], [role=listbox] li, .MuiAutocomplete-option, ul[role=menu] li');
  try{ await options.first().waitFor({ state:"visible", timeout: 5000 }); }catch(e){
    // A MUI Select with no list yet: type-ahead on the focused control.
    await control.press("Enter").catch(() => {});
    try{ await options.first().waitFor({ state:"visible", timeout: 2500 }); }catch(_){
      await page.keyboard.press("Escape").catch(() => {});
      log && log("warn", `${label}: no list of choices opened`);
      return { ok:false, reason:"no list opened" };
    }
  }
  const texts = (await options.allTextContents()).slice(0, 600);
  const hit = bestMatch(texts, wanted);
  if(hit == null){
    await page.keyboard.press("Escape").catch(() => {});
    log && log("warn", `${label}: none of [${wanted.join(", ")}] is in AskUni's list`);
    return { ok:false, reason:"not in AskUni's list" };
  }
  const idx = texts.indexOf(hit);
  const opt = options.nth(idx);
  await opt.scrollIntoViewIfNeeded().catch(() => {});
  await opt.click({ timeout: 8000 });
  log && log("info", `${label}: chose "${hit.trim()}"`);
  return { ok:true, chose:hit.trim() };
}
function bestMatch(list, wanted){
  const L = list.map(t => ({ raw:t, n:norm(t) })).filter(x => x.n);
  for(const w of wanted){ const n = norm(w); const e = L.find(x => x.n === n); if(e) return e.raw; }
  for(const w of wanted){ const n = norm(w); const e = L.find(x => x.n.startsWith(n)); if(e) return e.raw; }
  for(const w of wanted){ const n = norm(w); if(n.length < 3) continue; const e = L.find(x => x.n.includes(n)); if(e) return e.raw; }
  return null;
}

// ------------------------------------------------------------ phone
// A flag picker (defaulting to +90) and a number box. Typing the full
// international number, starting with "+", switches the flag by itself in
// the common phone widgets; the box's value is checked afterwards.
export async function fillPhone(page, label, phone, log){
  const digits = String(phone || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  if(digits.replace(/\D/g, "").length < 7) return { ok:false, reason:"no phone number in Orbuni" };
  const intl = digits.startsWith("+") ? digits : "+" + digits.replace(/^00/, "");
  const scope = await scopeOf(page);
  const box = await fieldBox(scope, label);
  const input = box ? await firstVisible(box.locator("input[type=tel], input:not([type=hidden]):not([type=file])")) : null;
  if(!input){ log && log("warn", `${label}: box not found`); return { ok:false, reason:"box not found" }; }
  await input.click({ timeout: 8000 });
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await input.press("Backspace").catch(() => {});
  await input.pressSequentially(intl, { delay: 35 });
  const got = (await input.inputValue().catch(() => "")).replace(/\D/g, "");
  const want = intl.replace(/\D/g, "");
  const ok = got.endsWith(want.slice(-7));
  log && log(ok ? "info" : "warn", `${label}: ${ok ? "filled" : "typed, but the box shows something else"}`);
  return { ok };
}

// ------------------------------------------------------------ dates
// Reads the box's own placeholder (DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, …)
// and types the date in exactly that shape.
export async function fillDate(page, label, iso, log){
  if(!iso) return { ok:false, reason:"no date in Orbuni" };
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  const scope = await scopeOf(page);
  let el = await firstVisible(scope.getByLabel(new RegExp("^\\s*" + esc(label) + "\\s*\\*?\\s*$", "i")));
  if(!el){ const box = await fieldBox(scope, label); if(box) el = await firstVisible(box.locator("input:not([type=hidden]):not([type=file])")); }
  if(!el){ log && log("warn", `${label}: date box not found`); return { ok:false, reason:"box not found" }; }
  const type = await el.getAttribute("type");
  if(type === "date"){ await el.fill(`${y}-${m}-${d}`); log && log("info", `${label}: filled`); return { ok:true }; }
  const ph = ((await el.getAttribute("placeholder")) || "").toUpperCase();
  let out;
  if(/^Y/.test(ph)) out = `${y}${ph.includes(".") ? "." : ph.includes("/") ? "/" : "-"}${m}${ph.includes(".") ? "." : ph.includes("/") ? "/" : "-"}${d}`;
  else if(/^M/.test(ph)) out = `${m}/${d}/${y}`;
  else out = `${d}${ph.includes(".") ? "." : ph.includes("-") ? "-" : "/"}${m}${ph.includes(".") ? "." : ph.includes("-") ? "-" : "/"}${y}`;
  await el.click({ timeout: 8000 });
  await el.press("Control+A").catch(() => {});
  await el.press("Backspace").catch(() => {});
  await el.pressSequentially(out, { delay: 30 });
  await el.press("Tab").catch(() => {});
  const v = await el.inputValue().catch(() => "");
  const ok = v.replace(/\D/g, "").length >= 8;
  log && log(ok ? "info" : "warn", `${label}: ${ok ? "filled as " + (ph || "DD/MM/YYYY") : "typed, but the box didn't take it"}`);
  return { ok };
}

// ------------------------------------------------------------ files
// Works when the real <input type=file> is hidden behind a button (setting
// files on a hidden input is fine), and falls back to clicking the visible
// upload button and answering the file chooser.
export async function uploadFile(page, label, filePath, log){
  if(!filePath) return { ok:false, reason:"no file in Orbuni" };
  const scope = await scopeOf(page);
  const texts = scope.getByText(new RegExp("^\\s*" + esc(label) + "\\s*\\*?\\s*$", "i"));
  const n = await texts.count();
  for(let i = 0; i < n; i++){
    const t = texts.nth(i);
    if(!(await t.isVisible().catch(() => false))) continue;
    const box = t.locator("xpath=ancestor-or-self::*[.//input[@type='file']][1]");
    if(await box.count()){
      const inp = box.first().locator("input[type=file]").first();
      try{ await inp.setInputFiles(filePath, { timeout: 8000 }); log && log("info", `${label}: uploaded`); return { ok:true }; }catch(e){}
    }
    const near = t.locator("xpath=ancestor-or-self::*[.//button or .//*[@role='button']][1]").first();
    const btn = await firstVisible(near.locator("button, [role=button], label"));
    if(btn){
      try{
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), btn.click()]);
        await chooser.setFiles(filePath);
        log && log("info", `${label}: uploaded (via its button)`);
        return { ok:true };
      }catch(e){}
    }
  }
  log && log("warn", `${label}: upload spot not found`);
  return { ok:false, reason:"upload spot not found" };
}

// ------------------------------------------------------------ steps
// What proves each step is really on screen.
const STEP_MARK = {
  1: (s) => s.getByText(/^\s*First Name\s*\*?\s*$/i),
  2: (s) => s.getByText(/^\s*Passport Number\s*\*?\s*$/i),
  3: (s) => s.getByText(/^\s*(Diploma|Transcript)\s*\*?\s*$/i),
  4: (s, page) => page.getByPlaceholder(/Type Interested Program/i),
};
export async function currentStep(page){
  const scope = await scopeOf(page);
  for(const k of [4, 3, 2, 1]){
    const m = STEP_MARK[k](scope, page);
    if(await firstVisible(m)) return k;
  }
  return 0;
}
// AskUni's own red messages, paired with the label they sit under.
export async function readErrors(page){
  const scope = await scopeOf(page);
  return await scope.evaluate((root) => {
    const out = [];
    const errs = root.querySelectorAll(".Mui-error.MuiFormHelperText-root, .MuiFormHelperText-root.Mui-error, [class*='error-message'], [class*='errorMessage'], .invalid-feedback, [role=alert]");
    errs.forEach((e) => {
      const msg = (e.textContent || "").trim(); if(!msg) return;
      let label = "";
      let p = e.parentElement;
      for(let i = 0; i < 5 && p && !label; i++){
        const l = p.querySelector("label"); if(l) label = (l.textContent || "").replace(/\*/g, "").trim();
        p = p.parentElement;
      }
      out.push({ field: label || "(unlabelled field)", message: msg });
    });
    return out;
  }).catch(() => []);
}
export async function nextStep(page, fromStep, log){
  const scope = await scopeOf(page);
  const next = await firstVisible(scope.getByRole("button", { name: /^\s*next\s*$/i }));
  if(!next) throw new StepBlocked(STEP_NAMES[fromStep], [], "The Next button isn't on screen.");
  await next.click();
  const mark = STEP_MARK[fromStep + 1];
  const deadline = Date.now() + 12000;
  while(Date.now() < deadline){
    const s = await scopeOf(page);
    if(await firstVisible(mark(s, page))){ log && log("info", `moved on to ${STEP_NAMES[fromStep + 1]}`); return; }
    await page.waitForTimeout(400);
  }
  const errors = await readErrors(page);
  throw new StepBlocked(STEP_NAMES[fromStep], errors,
    errors.length ? ("AskUni wants: " + errors.map(e => e.field + " — " + e.message).join("; "))
                  : "AskUni didn't open the next step and showed no reason.");
}

// ------------------------------------------------------------ the wizard
// `data` is prepared by the server (index.js): the student's fields plus
// local file paths. `log(level, text)` records progress for the portal.
export async function openWizard(page, portalUrl, log){
  await page.goto(portalUrl + "/users/student/list/", { waitUntil: "domcontentloaded", timeout: 30000 });
  if(/\/login/i.test(page.url())) throw new StepBlocked("login", [], "AskUni is asking for a login.");
  await page.getByRole("button", { name: /add student/i }).click({ timeout: 30000 });
  await STEP_MARK[1](await scopeOf(page)).first().waitFor({ state:"visible", timeout: 20000 });
  log && log("info", "opened Add Student User");
}

export async function step1(page, d, log){
  await fillText(page, "First Name", d.first_name, log);
  await fillText(page, "Last Name", d.last_name, log);
  const scope = await scopeOf(page);
  const email = (await firstVisible(scope.locator("#eMail"))) || (await firstVisible(scope.getByLabel(/^\s*e-?mail\s*\*?\s*$/i)));
  if(email && d.email){ await email.fill(d.email); log && log("info", "Email: filled"); }
  await pickOption(page, "Gender", d.gender === "female" ? ["Female", "Woman", "Kadın"] : d.gender === "male" ? ["Male", "Man", "Erkek"] : [], log);
  await fillPhone(page, "Mobile Phone", d.phone, log);
  if(d.files.photo) await uploadFile(page, "Profile Picture", d.files.photo, log);
  await nextStep(page, 1, log);
}
export async function step2(page, d, log){
  await fillText(page, "Passport Number", d.passport_number, log);
  await fillDate(page, "Birth Date", d.date_of_birth, log);
  const nat = countryName(d.nationality), res = countryName(d.country) || nat, birth = countryName(d.country_of_birth) || nat;
  await pickOption(page, "Country of Birth", countryAliases(birth), log);
  await pickOption(page, "Country of Residence", countryAliases(res), log);
  await pickOption(page, "Nationality", countryAliases(nat).concat(d.nationality ? [d.nationality] : []), log);
  await fillText(page, "City of Residence", d.city, log);
  await fillText(page, "Address", d.address_line, log);
  await fillText(page, "Mother Name", d.mother_name, log);
  await fillText(page, "Father Name", d.father_name, log);
  await fillDate(page, "Passport Date of Expire", d.passport_expiry, log);
  await fillDate(page, "Passport Date of Issue", d.passport_issue_date, log);
  await nextStep(page, 2, log);
}
export async function step3(page, d, log){
  await uploadFile(page, "Passport", d.files.passport, log);
  await uploadFile(page, "Diploma", d.files.diploma, log);
  await uploadFile(page, "Transcript", d.files.transcript, log);
  await nextStep(page, 3, log);
}
export async function step4(page, d, log){
  const box = page.getByPlaceholder(/Type Interested Program/i);
  await box.fill(d.course || "");
  await box.press("Enter");
  log && log("info", "searched for the programme");
  const hit = page.getByText(d.course, { exact: false });
  await hit.first().waitFor({ state:"visible", timeout: 20000 }).catch(() => {});
  // prefer the result that also names the university
  let row = null;
  if(d.university){
    const both = page.locator("*").filter({ hasText: d.course }).filter({ hasText: d.university });
    row = await firstVisible(both.last());
  }
  await (row ? row.getByText(d.course, { exact: false }).first() : hit.first()).click({ timeout: 15000 });
  await page.getByRole("button", { name: /\b(20\d{2})\s+(FALL|SPRING|SUMMER|WINTER)\b/i }).first().click({ timeout: 15000 });
  const dialog = page.getByRole("dialog", { name: /are you sure/i });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole("button", { name: /^\s*apply\s*$/i }).click();
  await page.getByText(/Application submit/i).waitFor({ timeout: 20000 });
  log && log("info", "AskUni accepted the application");
  await page.getByRole("button", { name: /^\s*finish\s*$/i }).click({ timeout: 15000 });
  await page.waitForURL(/\/users\/student\/\d+\/applications\/?/, { timeout: 20000 });
  const m = page.url().match(/\/users\/student\/(\d+)\//);
  return { askuni_student_id: m ? m[1] : null };
}

// Run from whichever step is on screen now (1 when starting fresh).
export async function runWizard(page, d, log, onStep){
  let at = await currentStep(page);
  if(!at){ throw new StepBlocked("start", [], "The Add Student window isn't open."); }
  const steps = { 1: step1, 2: step2, 3: step3 };
  while(at < 4){
    onStep && await onStep(at, STEP_NAMES[at]);
    await steps[at](page, d, log);
    at += 1;
  }
  onStep && await onStep(4, STEP_NAMES[4]);
  return await step4(page, d, log);
}

// ------------------------------------------------------------ logging in (version 3)
// The bot logs in by itself with the AskUni email and password kept in Render's
// environment settings (ASKUNI_EMAIL / ASKUNI_PASSWORD). The password is typed
// into AskUni's own login form and never written to a log or the database.
const CAPTCHA = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .cf-turnstile';
export async function isLoggedIn(page, portalUrl){
  if(!/\/users\//.test(page.url())) await page.goto(portalUrl + "/users/student/list/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  // AskUni's pages send a signed-out visitor to /login/ a moment after loading, so
  // wait until the page settles either way before deciding.
  const deadline = Date.now() + 15000;
  while(Date.now() < deadline){
    if(/\/login/i.test(page.url())) return false;
    if(await page.getByRole("button", { name: /add student/i }).first().isVisible().catch(() => false)){
      await page.waitForTimeout(1500);
      if(!/\/login/i.test(page.url())) return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}
export async function login(page, portalUrl, email, password, log){
  if(!email || !password) throw new StepBlocked("login", [], "The AskUni login isn't set up yet: add ASKUNI_EMAIL and ASKUNI_PASSWORD in Render → askuni-bot → Environment.");
  if(!/\/login/i.test(page.url())) await page.goto(portalUrl + "/login/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('input[type="password"]').first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  const emailBox = (await firstVisible(page.locator('input[type="email"]')))
    || (await firstVisible(page.getByLabel(/e-?mail|user ?name|kullanıcı/i)))
    || (await firstVisible(page.locator('input[name*="mail" i], input[name*="user" i], input[id*="mail" i], input[autocomplete="username"]')))
    || (await firstVisible(page.locator('input[type="text"]')));
  const passBox = await firstVisible(page.locator('input[type="password"]'));
  if(!emailBox || !passBox) throw new StepBlocked("login", [], "AskUni's login page didn't show an email and password box.");
  await emailBox.fill(email);
  await passBox.fill(password);
  log && log("info", "typed the AskUni login");
  const btn = (await firstVisible(page.getByRole("button", { name: /log ?in|sign ?in|giriş|continue|submit/i })))
    || (await firstVisible(page.locator('button[type="submit"], input[type="submit"]')));
  if(btn) await btn.click(); else await passBox.press("Enter");
  const deadline = Date.now() + 25000;
  while(Date.now() < deadline){
    if(!/\/login/i.test(page.url())){ log && log("info", "logged in to AskUni"); return true; }
    if(await firstVisible(page.locator(CAPTCHA))) throw new StepBlocked("login", [], "AskUni showed a 'prove you're human' check, which the bot can't answer. Tell Claude — there is a way round it.");
    await page.waitForTimeout(500);
  }
  const errors = await readErrors(page);
  const alert = await page.locator('[role="alert"], .MuiAlert-message, .alert-danger, p.Mui-error, .MuiFormHelperText-root.Mui-error').allTextContents().catch(() => []);
  const said = errors.map(e => e.message).concat(alert.map(a => a.trim()).filter(Boolean)).slice(0, 3).join("; ");
  throw new StepBlocked("login", errors, "AskUni didn't accept the login" + (said ? " (" + said + ")" : "") + ". Check ASKUNI_EMAIL and ASKUNI_PASSWORD in Render.");
}
