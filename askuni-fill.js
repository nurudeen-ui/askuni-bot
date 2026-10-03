// askuni-fill.js — version 4.1 (2 Oct 2026): one engine for every dropdown, date and upload (strict check, several ways to fill, label variants, field inventory in the log) ; re-checks text boxes before Next
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
// Two ways to find a box: the label's own link (getByLabel) and the box drawn under the label
// text. On AskUni's step 2 the link points somewhere else for some boxes (the bot "filled" them
// but the boxes on screen stayed empty), so when the two disagree the box on screen wins.
let lastPick = "";
async function locateText(page, label){
  const scope = await scopeOf(page);
  const byLink = await firstVisible(scope.getByLabel(new RegExp("^\\s*" + esc(label) + "\\s*\\*?\\s*$", "i")));
  const box = await fieldBox(scope, label);
  // only trust "the box under the label" when that block holds exactly one box
  const inBox = box ? box.locator("input:not([type=hidden]):not([type=file]), textarea") : null;
  const underLabel = inBox && (await inBox.count()) === 1 ? await firstVisible(inBox) : null;
  lastPick = "";
  if(byLink && underLabel){
    const h = await underLabel.elementHandle().catch(() => null);
    const same = h ? await byLink.evaluate((a, b) => a === b, h).catch(() => true) : true;
    if(!same){ lastPick = " (used the box under the label — AskUni's label link pointed to another box)"; return underLabel; }
  }
  return byLink || underLabel;
}
// Every text box we filled in the current step, so a last sweep can catch any the page cleared afterwards.
let typedBoxes = [];
export function resetTyped(){ typedBoxes = []; }
async function typeIn(el, value){
  await el.fill(String(value), { timeout: 8000 });
  await commit(el);
  let now = await el.inputValue().catch(() => String(value));
  if(String(now).trim() === "" ){
    await el.click({ timeout: 3000 }).catch(() => {});
    await el.press("Control+A").catch(() => {});
    await el.pressSequentially(String(value), { delay: 15 }).catch(() => {});
    now = await el.inputValue().catch(() => String(value));
  }
  return String(now).trim() !== "";
}
export async function fillText(page, label, value, log){
  if(value == null || value === "") return { ok:false, reason:"no value in Orbuni" };
  const el = await locateText(page, label);
  if(!el){ log && log("warn", `${label}: box not found`); return { ok:false, reason:"box not found" }; }
  const kept = await typeIn(el, value);
  typedBoxes.push({ label, value });
  if(!kept){ log && log("warn", `${label}: typed but the box stayed empty`); return { ok:false, reason:"box stayed empty" }; }
  log && log("info", `${label}: filled${lastPick}`);
  return { ok:true };
}
// Last look before Next: the page sometimes clears boxes after a dropdown choice. Put back anything that went empty.
export async function sweepTyped(page, log){
  await page.waitForTimeout(1000);   // let AskUni finish redrawing the form after the country lists
  let refilled = 0;
  for(const t of typedBoxes){
    try{
      const el = await locateText(page, t.label);
      if(!el) continue;
      const now = String(await el.inputValue().catch(() => t.value)).trim();
      if(now === ""){
        const ok = await typeKeys(el, t.value);
        if(ok) refilled++;
        log && log(ok ? "info" : "warn", ok ? `${t.label}: had been cleared by the page, filled again` : `${t.label}: still empty after a second try`);
      }
    }catch(e){}
  }
  return refilled;
}
// When Next fails, write down for each typed box what is really in it, so the log shows the cause.
async function describeTyped(page, log){
  if(!log) return;
  const scope = await scopeOf(page);
  for(const t of typedBoxes){
    try{
      const box = await fieldBox(scope, t.label);
      const el = box ? await firstVisible(box.locator("input:not([type=hidden]):not([type=file]), textarea")) : null;
      const info = el ? await el.evaluate((e) => ({ id: e.id, name: e.name, v: e.value })) : null;
      log("info", `check ${t.label}: ` + (info ? `box on screen id="${info.id}" name="${info.name}" holds ${info.v ? "text" : "NOTHING"}` : "no box found under the label"));
    }catch(e){}
  }
}
// Types like a person (click, select all, key by key, then leave the box), for forms that ignore a pasted value.
async function typeKeys(el, value){
  await el.click({ timeout: 3000 }).catch(() => {});
  await el.press("Control+A").catch(() => {});
  await el.pressSequentially(String(value), { delay: 20 }).catch(() => {});
  await commit(el);
  return String(await el.inputValue().catch(() => "")).trim() !== "";
}
// Tell the page the box is finished (some forms only save a value on "change" / leaving the box).
async function commit(el){
  await el.evaluate((e) => { e.dispatchEvent(new Event("change", { bubbles: true })); e.dispatchEvent(new Event("blur")); }).catch(() => {});
}

// ------------------------------------------------------------ dropdowns
// The part of a dropdown a person would click: skips the invisible helper input many widgets hide
// behind the real control (aria-hidden, opacity 0, no pointer events).
async function findControl(box){
  const cands = box.locator('[role=combobox], [aria-haspopup], [tabindex="0"]:not(input), input:not([type=hidden]):not([type=file]), div[class*="select" i], div[class*="dropdown" i]');
  const n = await cands.count();
  let firstSeen = null;
  for(let i = 0; i < n; i++){
    const el = cands.nth(i);
    if(!(await el.isVisible().catch(() => false))) continue;
    if(!firstSeen) firstSeen = el;
    const clickable = await el.evaluate((e) => {
      const st = getComputedStyle(e);
      return e.getAttribute("aria-hidden") !== "true" && st.opacity !== "0" && st.pointerEvents !== "none" && e.getAttribute("tabindex") !== "-1";
    }).catch(() => true);
    if(clickable) return el;
  }
  return firstSeen;
}
// Click a control; if something sits on top of it, click the field's own box instead, then its centre point.
async function openControl(page, box, control){
  try{ await control.click({ timeout: 2500 }); return true; }catch(e){}
  try{ await box.click({ timeout: 2500, force: true }); return true; }catch(e){}
  try{
    const r = await box.boundingBox();
    if(r){ await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2); return true; }
  }catch(e){}
  return false;
}
// Works for a plain <select>, a MUI Select (click → pick from a list) and a
// MUI Autocomplete (type → pick). `wanted` is a list of acceptable texts.
async function pickOptionCore(page, label, wanted, log){
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

  const control = await findControl(box);
  if(!control){ log && log("warn", `${label}: no clickable control`); return { ok:false, reason:"no control" }; }
  await openControl(page, box, control);
  const typeable = await control.evaluate(e => e.tagName === "INPUT" && !e.readOnly).catch(() => false);
  if(typeable){ await control.fill(""); await control.pressSequentially(wanted[0].slice(0, 24), { delay: 25 }); }

  const options = page.locator('[role=option], [role=listbox] li, .MuiAutocomplete-option, ul[role=menu] li, .MuiMenuItem-root, [id*="-option-"], [class*="select__option"], [class*="dropdown-item"]');
  try{ await options.first().waitFor({ state:"visible", timeout: 5000 }); }catch(e){
    // A MUI Select with no list yet: type-ahead on the focused control.
    await control.press("Enter").catch(() => {});
    try{ await options.first().waitFor({ state:"visible", timeout: 2500 }); }catch(_){
      await page.keyboard.press("Escape").catch(() => {});
      // Last resorts: drive the control with the keyboard (open it, type the first
      // letters, Enter), then trust only what the box itself shows afterwards.
      const vt = await pickByVisibleText(page, box, control, wanted, log, label);
      if(vt) return vt;
      const kb = await pickByKeyboard(page, box, control, wanted, log, label);
      if(kb) return kb;
      await describeField(page, box, log, label);
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
// The one dropdown entry point. Picks with the normal list; if that finds nothing, or the choice
// does not stick when the box loses focus, tries clicking the visible choice and then the keyboard.
export async function pickOption(page, label, wanted, log){
  try{ return await pickOptionSafe(page, label, wanted, log); }
  catch(e){ log && log("warn", `${label}: ${String(e.message || e).split("\n")[0].slice(0, 120)}`); return { ok:false, reason:"error" }; }
}
async function pickOptionSafe(page, label, wanted, log){
  wanted = (Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean);
  if(!wanted.length) return { ok:false, reason:"no value in Orbuni" };
  let r;
  try{ r = await pickOptionCore(page, label, wanted, log); }
  catch(e){ log && log("warn", `${label}: first way failed (${String(e.message || e).split("\n")[0].slice(0, 90)})`); r = { ok:false, reason:"no control" }; }
  const scope = await scopeOf(page);
  const box = await fieldBox(scope, label);
  if(!box) return r;
  if(r.ok){
    if(await confirmChosen(page, box, wanted)) return r;
    log && log("warn", `${label}: the choice did not stick, trying another way`);
  }else if(r.reason !== "no list opened" && r.reason !== "no control"){
    return r;
  }
  const control = await findControl(box);
  if(!control) return r;
  const vt = await pickByVisibleText(page, box, control, wanted, log, label);
  if(vt) return vt;
  const kb = await pickByKeyboard(page, box, control, wanted, log, label);
  if(kb) return kb;
  if(r.ok) await describeField(page, box, log, label);
  return { ok:false, reason:"could not set it" };
}
// What the box shows now (its visible text and input values), lower-cased.
async function shownIn(box){
  return await box.evaluate((el) => {
    const vals = Array.from(el.querySelectorAll("input,select,textarea")).map(i => i.value || "").join(" ");
    return ((el.innerText || "") + " " + vals).toLowerCase();
  }).catch(() => "");
}
// Proof that a choice really stuck: let go of the box (a word that was only typed, never
// chosen, is cleared when the box loses focus), then see whether the box still shows it.
async function confirmChosen(page, box, wanted){
  const targets = wanted.map(w => norm(w)).filter(Boolean);
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(400);
  const t = norm(await shownIn(box));
  return targets.some(w => new RegExp("(^|[^a-z])" + esc(w) + "([^a-z]|$)").test(t));
}
// Open the dropdown and click whatever visible, un-covered element says exactly the wanted
// word. The student list behind the pop-up also says "Male"/"Female", but it is covered, so
// it is never picked.
async function pickByVisibleText(page, box, control, wanted, log, label){
  const names = wanted.map(w => String(w).trim().toLowerCase()).filter(Boolean);
  await openControl(page, box, control);
  const typeable = await control.evaluate(e => e.tagName === "INPUT" && !e.readOnly && e.getAttribute("aria-hidden") !== "true").catch(() => false);
  if(typeable){ await control.fill("").catch(() => {}); await control.pressSequentially(String(wanted[0]).slice(0, 24), { delay: 30 }).catch(() => {}); }
  await page.waitForTimeout(800);
  const handle = await page.evaluateHandle((names) => {
    const own = (el) => Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim().toLowerCase();
    const found = Array.from(document.querySelectorAll("body *")).filter((el) => {
      if(!names.includes(own(el))) return false;
      if(el.closest("table, tr, td, [role=row], [role=gridcell]")) return false;
      let r = el.getBoundingClientRect();
      if(r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      if(st.visibility === "hidden" || st.display === "none") return false;
      if(r.bottom < 0 || r.top > innerHeight){ el.scrollIntoView({ block:"center" }); r = el.getBoundingClientRect(); }
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if(cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      return !!top && (top === el || el.contains(top) || top.contains(el));
    });
    return found.length ? found[0] : null;
  }, names);
  const el = handle.asElement();
  if(!el) return null;
  await el.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  if(await confirmChosen(page, box, wanted)){ log && log("info", `${label}: chose "${wanted[0]}" (clicked the visible choice)`); return { ok:true, chose:String(wanted[0]) }; }
  return null;
}
// Keyboard fallback: open the control, type the first letters, Enter - then prove it stuck.
async function pickByKeyboard(page, box, control, wanted, log, label){
  for(const key of ["Enter", "ArrowDown", "Space"]){
    try{
      await control.focus().catch(() => {});
      await control.press(key).catch(() => {});
      await page.waitForTimeout(400);
      await page.keyboard.type(String(wanted[0]).slice(0, 4), { delay: 60 });
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(500);
      if(await confirmChosen(page, box, wanted)){ log && log("info", `${label}: chose "${wanted[0]}" (keyboard)`); return { ok:true, chose:String(wanted[0]) }; }
    }catch(e){}
  }
  return null;
}
// When a field cannot be filled, record a short look at its markup and at any open list,
// so the next fix is exact.
async function describeField(page, box, log, label){
  try{
    const html = await box.evaluate((el) => el.outerHTML.replace(/\s+/g, " ").replace(/data:[^"']{20,}/g, "data:…").slice(0, 700));
    log && log("info", `${label}: field markup → ${html}`);
  }catch(e){}
  try{
    const layer = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('[role=listbox],[role=menu],[class*="menu" i],[class*="popover" i],[class*="dropdown" i],[class*="option" i]'))
        .filter(vis).slice(0, 2).map(e => e.outerHTML.replace(/\s+/g, " ").slice(0, 500));
    });
    if(layer.length) log && log("info", `${label}: open list markup → ${layer.join("  ||  ")}`);
  }catch(e){}
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
  const el = await locateText(page, label);   // same rule as text boxes: the box under the label wins
  if(!el){ log && log("warn", `${label}: date box not found`); return { ok:false, reason:"box not found" }; }
  const fbox = await fieldBox(scope, label);
  const type = await el.getAttribute("type");
  if(type === "date"){ await el.fill(`${y}-${m}-${d}`); log && log("info", `${label}: filled`); return { ok:true }; }
  const ph = ((await el.getAttribute("placeholder")) || "").toUpperCase();
  let out;
  if(/^Y/.test(ph)) out = `${y}${ph.includes(".") ? "." : ph.includes("/") ? "/" : "-"}${m}${ph.includes(".") ? "." : ph.includes("/") ? "/" : "-"}${d}`;
  else if(/^M/.test(ph)) out = `${m}/${d}/${y}`;
  else out = `${d}${ph.includes(".") ? "." : ph.includes("-") ? "-" : "/"}${m}${ph.includes(".") ? "." : ph.includes("-") ? "-" : "/"}${y}`;
  const sep = ph.includes(".") ? "." : ph.includes("/") ? "/" : "-";
  const typeDate = async (txt, delay = 30) => {
    await el.click({ timeout: 8000 }).catch(() => {});
    await el.press("Control+A").catch(() => {});
    await el.press("Backspace").catch(() => {});
    await el.pressSequentially(txt, { delay });
    await el.press("Tab").catch(() => {});
  };
  // AskUni's date boxes say DD-MM-YYYY but read typed dates month first ("04-09-2000" showed as
  // "April 9, 2000"; "13-09-2029" became a wrong date). When the box shows a written-out date,
  // check it against the real one; if it is wrong, type the date month first.
  // what the field really displays: the typed box, plus any other box or text in the same field
  // (date pickers often show a written-out copy like "April 9, 2000" next to the hidden typed one)
  const displayed = async () => {
    const vals = [await el.inputValue().catch(() => "")];
    if(fbox) vals.push(...(await fbox.locator("input").evaluateAll(xs => xs.map(x => x.value)).catch(() => [])),
                       (await fbox.innerText().catch(() => "")));
    return vals.find(v => /[a-z]{3,}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-z]{3,}\.?\s+\d{4}/i.test(v)) || vals[0] || "";
  };
  const shows = async () => {
    let v = await displayed();
    const w = v.match(/[a-z]{3,}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-z]{3,}\.?\s+\d{4}/i); if(w) v = w[0];
    if(!/[a-z]/i.test(v)) return v.replace(/\D/g, "").length >= 8 ? "digits" : "empty";
    const t = new Date(v.replace(/(\d)(st|nd|rd|th)\b/gi, "$1"));
    if(isNaN(t)) return "digits";
    return t.getFullYear() === +y && t.getMonth() + 1 === +m && t.getDate() === +d ? "right" : "wrong";
  };
  // AskUni's date boxes say DD-MM-YYYY but read typed dates month first (04-09-2000 became
  // "April 9, 2000"), and only redraw the date a moment after leaving the box. So for day-first
  // boxes type month first, wait, check what the field shows, and fall back to day first.
  const tries = /^Y/.test(ph) || /^M/.test(ph) ? [out] : [`${m}${sep}${d}${sep}${y}`, out];
  let r = "empty";
  for(const txt of tries){
    await typeDate(txt);
    await page.waitForTimeout(900);
    r = await shows();
    if(r !== "wrong") break;
    log && log("info", `${label}: AskUni showed a different date after typing ${txt}, trying the other order`);
  }
  if(r === "empty"){
    // Segmented date boxes (day / month / year) take plain digits, in the order they show.
    await typeDate(/^Y/.test(ph) ? `${y}${m}${d}` : /^M/.test(ph) ? `${m}${d}${y}` : `${d}${m}${y}`, 40);
    r = await shows();
  }
  const ok = r === "right" || r === "digits";
  log && log("info", `${label}: the box shows "${String(await displayed()).replace(/\s+/g, " ").slice(0, 60)}"`);
  log && log(ok ? "info" : "warn", `${label}: ${ok ? "filled" + (r === "right" ? " and checked" : " as " + (ph || "DD/MM/YYYY")) : r === "wrong" ? "AskUni shows a different date — please check it" : "typed, but the box didn't take it"}`);
  return { ok };
}

// ------------------------------------------------------------ files
// Works when the real <input type=file> is hidden behind a button (setting
// files on a hidden input is fine), and falls back to clicking the visible
// upload button and answering the file chooser.
// After a file is chosen, wait for its name to show up in the pop-up (AskUni uploads in the background).
async function uploadShown(page, filePath){
  const base = String(filePath).split(/[\\/]/).pop().replace(/\.[^.]+$/, "").slice(0, 18).toLowerCase();
  if(!base) return true;
  for(let i = 0; i < 16; i++){
    const w = wizard(page);
    const txt = ((await w.count()) ? await w.innerText().catch(() => "") : "").toLowerCase();
    if(txt.includes(base)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}
// Last resort for the documents step: the n-th file box in the pop-up (Passport, Diploma, Transcript).
export async function uploadByPosition(page, index, filePath, log, label){
  if(!filePath) return { ok:false, reason:"no file in Orbuni" };
  const w = wizard(page);
  const inputs = (await w.count()) ? w.locator("input[type=file]") : page.locator("input[type=file]");
  if((await inputs.count()) <= index) return { ok:false, reason:"upload spot not found" };
  try{
    await inputs.nth(index).setInputFiles(filePath, { timeout: 8000 });
    const shown = await uploadShown(page, filePath);
    log && log(shown ? "info" : "warn", `${label}: uploaded (by position ${index + 1})${shown ? "" : ", but its name did not appear"}`);
    return { ok:true };
  }catch(e){ return { ok:false, reason:"upload spot not found" }; }
}
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
      try{
        await inp.setInputFiles(filePath, { timeout: 8000 });
        const shown = await uploadShown(page, filePath);
        log && log(shown ? "info" : "warn", `${label}: uploaded${shown ? "" : ", but its name did not appear"}`);
        return { ok:true };
      }catch(e){}
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


// ------------------------------------------------------------ what the form really contains
// Every field label in the open pop-up with its control type. Logged at the start of each step so
// a wrong label guess shows up at once, and used to find a field under a different wording.
async function domLabels(page){
  const w = wizard(page);
  if(!(await w.count())) return [];
  return await w.evaluate((root) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = (t) => (t || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
    const out = []; const seen = new Set();
    root.querySelectorAll("label, legend, .MuiInputLabel-root, .MuiFormLabel-root").forEach((l) => {
      if(!vis(l)) return;
      const text = clean(l.textContent);
      if(!text || text.length > 60 || seen.has(text)) return;
      seen.add(text);
      let c = null, p = l;
      for(let i = 0; i < 4 && p && !c; i++){ p = p.parentElement; if(p) c = p.querySelector("input,select,textarea,[role=combobox],[aria-haspopup]"); }
      let type = "?";
      if(c){
        const t = c.tagName;
        type = t === "SELECT" ? "select" : t === "TEXTAREA" ? "textarea" : (c.getAttribute("role") === "combobox" || c.getAttribute("aria-haspopup")) ? "dropdown" : (c.type || "text");
        if(c.type === "checkbox") type = "toggle";
        if(c.type === "file") type = "file";
      }
      out.push({ text, type });
    });
    return out;
  }).catch(() => []);
}
async function inventory(page, log, stepName){
  try{
    const labels = await domLabels(page);
    const w = wizard(page);
    const files = (await w.count()) ? await w.locator("input[type=file]").count() : 0;
    log && log("info", `${stepName} fields → ${labels.map(l => l.text + "(" + l.type + ")").join(", ") || "none seen"}${files ? " · file inputs: " + files : ""}`);
  }catch(e){}
}
// One stuck field must never stop the rest of the form.
async function safely(doIt, label, log){
  try{ return await doIt(label); }
  catch(e){ log && log("warn", `${label}: ${String(e.message || e).split("\n")[0].slice(0, 120)}`); return { ok:false, reason:"error" }; }
}
// Try each wording of a field's label; if none exists, look for any label on screen that matches.
async function fillAny(page, variants, rx, doIt, log){
  let last = { ok:false, reason:"box not found" };
  const tried = new Set();
  for(const v of variants){
    tried.add(v.toLowerCase());
    last = await safely(doIt, v, log);
    if(last.ok) return last;
    if(last.reason && !/not found|no control|error/i.test(last.reason)) return last;
  }
  const seen = await domLabels(page);
  for(const l of seen){
    if(tried.has(l.text.toLowerCase()) || !rx.test(l.text)) continue;
    log && log("info", `using the label "${l.text}" for ${variants[0]}`);
    last = await safely(doIt, l.text, log);
    if(last.ok) return last;
  }
  return last;
}

// ------------------------------------------------------------ steps
// What proves each step is really on screen.
const STEP_MARK = {
  1: (s) => s.getByText(/^\s*First Name\s*\*?\s*$/i),
  2: (s) => s.getByText(/^\s*(Passport Number|Birth Date|Date of Birth|Mother Name|Father Name|Country of Birth)\s*\*?\s*$/i),
  3: (s) => s.getByText(/^\s*(Diploma|Transcript)\s*\*?\s*$|Drop\s+(a\s+)?files?\s+here/i),
  4: (s, page) => page.getByPlaceholder(/Type Interested Program/i),
};
export async function currentStep(page){
  // Only the "Add Student User" window counts. AskUni's student LIST also has a
  // "Passport Number" column (Sep 2026), which used to look like step 2 of the form.
  if(!(await wizard(page).count())) return 0;
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
// Anything AskUni is saying right now: toasts, alerts, red helper text, and the pop-up's own words.
async function whatPageSays(page){
  return await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
    const pick = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis).map(e => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    const alerts = pick('[role=alert], [role=status], .Toastify__toast, .MuiSnackbar-root, .MuiAlert-root, .swal2-popup, [class*="toast" i], [class*="snack" i], [class*="notif" i]');
    const errs = pick('.MuiFormHelperText-root.Mui-error, [class*="error" i], .invalid-feedback');
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).map(e => (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 260));
    return { alerts: alerts.slice(0, 4), errs: errs.slice(0, 4), dialog: dlg.slice(-1)[0] || "" };
  }).catch(() => ({ alerts: [], errs: [], dialog: "" }));
}
export async function nextStep(page, fromStep, log, retried = false){
  const scope = await scopeOf(page);
  const next = await firstVisible(scope.getByRole("button", { name: /^\s*next\s*$/i }));
  if(!next) throw new StepBlocked(STEP_NAMES[fromStep], [], "The Next button isn't on screen.");
  // Give a just-chosen photo time to finish, and wait until Next can be pressed.
  await page.waitForTimeout(2500);
  for(let i = 0; i < 20 && !(await next.isEnabled().catch(() => true)); i++) await page.waitForTimeout(500);
  await next.scrollIntoViewIfNeeded().catch(() => {});
  // AskUni sometimes refuses a step without saying so on screen. Record what its server answers
  // after Next (requests that fail) and any message that pops up and disappears while we wait.
  const answers = [], flashes = new Set();
  const onResp = async (r) => {
    try{
      const t = r.request().resourceType();
      if(!["xhr", "fetch"].includes(t)) return;
      const st = r.status();
      let body = "";
      if(st >= 400 || r.request().method() !== "GET") body = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
      if(st >= 400 || /error|invalid|required|exist|already|must/i.test(body))
        answers.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${st} ${body}`);
    }catch(_){}
  };
  page.on("response", onResp);
  await next.click();
  const mark = STEP_MARK[fromStep + 1];
  const deadline = Date.now() + 30000;   // AskUni creates the account before it shows the next step
  try{
  while(Date.now() < deadline){
    const said0 = await whatPageSays(page);
    for(const a of said0.alerts) if(!/^askuni \| search/i.test(a)) flashes.add(a.slice(0, 160));
    const s = await scopeOf(page);
    if(await firstVisible(mark(s, page))){ log && log("info", `moved on to ${STEP_NAMES[fromStep + 1]}`); return; }
    await page.waitForTimeout(400);
  }
  }finally{ page.off("response", onResp); }
  if(answers.length) log && log("warn", "AskUni's server answered: " + answers.slice(0, 4).join(" | "));
  if(flashes.size) log && log("warn", "AskUni flashed: " + Array.from(flashes).slice(0, 4).join(" | "));
  // AskUni sometimes empties boxes we typed (it showed "This field is required" under them).
  // Put them back key by key and press Next once more before asking a person.
  if(!retried && typedBoxes.length && (await sweepTyped(page, log)) > 0){
    log && log("info", "pressing Next again after filling the emptied boxes");
    return nextStep(page, fromStep, log, true);
  }
  await describeTyped(page, log);
  const errors = await readErrors(page);
  if(errors.length) throw new StepBlocked(STEP_NAMES[fromStep], errors, "AskUni wants: " + errors.map(e => e.field + " — " + e.message).join("; "));
  const said = await whatPageSays(page);
  const words = [...flashes, ...answers.map(a => "server: " + a), ...said.alerts, ...said.errs].join(" | ");
  log && log("info", `AskUni's screen after Next → alerts: [${said.alerts.join(" | ")}] errors: [${said.errs.join(" | ")}] pop-up: ${said.dialog}`);
  throw new StepBlocked(STEP_NAMES[fromStep], [],
    words ? ("AskUni didn't open the next step. It says: " + words.slice(0, 280))
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
  await fillAny(page, ["First Name"], /first\s*name|^name$|given/i, (l) => fillText(page, l, d.first_name, log), log);
  await fillAny(page, ["Last Name"], /last\s*name|sur\s*name|family/i, (l) => fillText(page, l, d.last_name, log), log);
  const scope = await scopeOf(page);
  const email = (await firstVisible(scope.locator("#eMail"))) || (await firstVisible(scope.getByLabel(/^\s*e-?mail\s*\*?\s*$/i)));
  if(email && d.email){ await email.fill(d.email); log && log("info", "Email: filled"); }
  const g = d.gender === "female" ? ["Female", "Woman", "Kadın"] : d.gender === "male" ? ["Male", "Man", "Erkek"] : [];
  await fillAny(page, ["Gender", "Sex"], /gender|sex/i, (l) => pickOption(page, l, g, log), log);
  await fillPhone(page, "Mobile Phone", d.phone, log);
  if(d.files.photo) await fillAny(page, ["Profile Picture", "Profile Photo", "Photo"], /profile|photo|picture|avatar/i, (l) => uploadFile(page, l, d.files.photo, log), log);
  await nextStep(page, 1, log);
}
export async function step2(page, d, log){
  resetTyped();
  const nat = countryName(d.nationality), res = countryName(d.country) || nat, birth = countryName(d.country_of_birth) || nat;
  const text = (variants, rx, v) => fillAny(page, variants, rx, (l) => fillText(page, l, v, log), log);
  const date = (variants, rx, v) => fillAny(page, variants, rx, (l) => fillDate(page, l, v, log), log);
  const pick = (variants, rx, v) => fillAny(page, variants, rx, (l) => pickOption(page, l, v, log), log);
  await text(["Passport Number", "Passport No", "Passport No."], /passport\s*(no|num|#)/i, d.passport_number);
  await date(["Birth Date", "Date of Birth", "Birthday"], /birth\s*date|date\s*of\s*birth|birthday|^dob$/i, d.date_of_birth);
  await pick(["Country of Birth", "Birth Country", "Place of Birth"], /country\s*of\s*birth|birth\s*country|place\s*of\s*birth/i, countryAliases(birth));
  await pick(["Country of Residence", "Residence Country", "Country"], /residen|^country$/i, countryAliases(res));
  await pick(["Nationality", "Citizenship"], /national|citizen/i, countryAliases(nat).concat(d.nationality ? [d.nationality] : []));
  // choosing a country redraws part of the form a moment later; typing before that gets wiped
  await page.waitForTimeout(1500);
  await text(["City of Residence", "City"], /city/i, d.city);
  await text(["Address", "Home Address", "Residence Address"], /address/i, d.address_line);
  await text(["Mother Name", "Mother's Name", "Mother Full Name"], /mother/i, d.mother_name);
  await text(["Father Name", "Father's Name", "Father Full Name"], /father/i, d.father_name);
  await date(["Passport Date of Expire", "Passport Expiry Date", "Passport Expiration Date", "Date of Expire", "Expiry Date"], /expir/i, d.passport_expiry);
  await date(["Passport Date of Issue", "Passport Issue Date", "Date of Issue", "Issue Date"], /issue/i, d.passport_issue_date);
  await sweepTyped(page, log);
  await nextStep(page, 2, log);
}
export async function step3(page, d, log){
  const doc = async (variants, rx, file, index) => {
    const r = await fillAny(page, variants, rx, (l) => uploadFile(page, l, file, log), log);
    if(!r.ok && file) return await uploadByPosition(page, index, file, log, variants[0]);
    return r;
  };
  await doc(["Passport", "Passport Copy", "Passport Scan"], /passport/i, d.files.passport, 0);
  if(d.files.diplomaFromTranscript) log && log("info", "Diploma: the student has no diploma in Orbuni, sending the transcript instead");
  await doc(["Diploma", "High School Diploma", "Diploma Certificate"], /diploma|certificate/i, d.files.diploma, 1);
  await doc(["Transcript", "Transcripts", "Academic Transcript"], /transcript/i, d.files.transcript, 2);
  await nextStep(page, 3, log);
}
// The programme search box, in the Add Student wizard or in Add New Application. AskUni's text
// "Type Interested Program and Press Enter" isn't always a real placeholder, so try several ways.
export async function programSearch(page){
  const dlg = page.getByRole("dialog").filter({ hasText: /interested program|add new application|apply to university/i }).last();
  const scope = (await dlg.count()) ? dlg : page.locator("body");
  for(const loc of [
    scope.getByPlaceholder(/interested program|press enter/i),
    scope.getByRole("textbox", { name: /interested program|press enter/i }),
    scope.getByLabel(/interested program|press enter/i),
    scope.locator('input[type="search"]'),
    scope.locator('input[placeholder*="rogram" i]'),
    // last resort: the one plain text box in the window (the filters on the left are dropdowns)
    scope.locator('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([role=combobox]):not([readonly]):not([aria-autocomplete])'),
  ]){
    const el = await firstVisible(loc).catch(() => null);
    if(el) return el;
  }
  return null;
}
// what buttons and choices the open window offers (for the log, when a step goes wrong)
async function buttonsShown(page){
  return await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role="dialog"]')).pop() || document.body;
    return Array.from(d.querySelectorAll('button, [role="button"], [role="option"]'))
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map(e => (e.innerText || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 25).join(" | ");
  }).catch(() => "");
}
export async function step4(page, d, log){
  const box = await programSearch(page);
  if(!box) throw new StepBlocked(STEP_NAMES[4], [], "The programme search box isn't on screen.");
  await box.click().catch(() => {});
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
  if(!(await hit.first().isVisible().catch(() => false))) throw new StepBlocked(STEP_NAMES[4], [], `AskUni's search didn't show "${d.course}"` + (d.university ? ` at ${d.university}` : "") + ".");
  await (row ? row.getByText(d.course, { exact: false }).first() : hit.first()).click({ timeout: 15000 });
  log && log("info", "chose the programme");
  await page.waitForTimeout(1500);
  const season = page.getByRole("button", { name: /\b(20\d{2})\s+(FALL|SPRING|SUMMER|WINTER)\b/i }).first();
  if(!(await season.waitFor({ timeout: 15000 }).then(() => true).catch(() => false))){
    log && log("info", "after choosing the programme AskUni offers: " + await buttonsShown(page));
    throw new StepBlocked(STEP_NAMES[4], [], "AskUni didn't show an intake (like 2026 FALL) to choose.");
  }
  log && log("info", "intake: " + (await season.innerText().catch(() => "")).replace(/\s+/g, " "));
  await season.click({ timeout: 15000 });
  const dialog = page.getByRole("dialog", { name: /are you sure/i });
  if(!(await dialog.waitFor({ timeout: 15000 }).then(() => true).catch(() => false))){
    log && log("info", "after choosing the intake AskUni offers: " + await buttonsShown(page));
    throw new StepBlocked(STEP_NAMES[4], [], "AskUni didn't ask to confirm the application.");
  }
  await dialog.getByRole("button", { name: /^\s*apply\s*$/i }).click();
  if(!(await page.getByText(/Application submit/i).waitFor({ timeout: 20000 }).then(() => true).catch(() => false)))
    throw new StepBlocked(STEP_NAMES[4], [], "Apply was pressed but AskUni didn't confirm it. Check the student's applications on AskUni before sending again.");
  log && log("info", "AskUni accepted the application");
  // the application is in; closing the window afterwards must not turn this into a failure
  await page.getByRole("button", { name: /^\s*finish\s*$/i }).click({ timeout: 15000 }).catch(() => {});
  await page.waitForURL(/\/users\/student\/\d+\/applications\/?/, { timeout: 20000 }).catch(() => {});
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
    await inventory(page, log, STEP_NAMES[at]);
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
  if(await currentStep(page).catch(() => 0)) return true;   // the Add Student form is open, so we are logged in
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
  // Since late September 2026 AskUni's login page first asks "Select your account type"
  // (I'm a Student / I'm a Partner). Orbuni is a partner agency, so pick Partner first.
  const pass = page.locator('input[type="password"]').first();
  const picker = page.locator('button[aria-label="Sign in as Partner"]')
    .or(page.getByRole("button", { name: /sign in as partner|i'?m a partner/i }))
    .or(page.getByText(/^I'?m a Partner$/i)).first();
  const t0 = Date.now();
  while(Date.now() - t0 < 20000){
    if(await pass.isVisible().catch(() => false)) break;
    if(await picker.isVisible().catch(() => false)){
      await picker.click().catch(() => {});
      log && log("info", "chose 'I'm a Partner' on AskUni's login page");
      await pass.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
      break;
    }
    await page.waitForTimeout(400);
  }
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

// ------------------------------------------------------------ a student who is already on AskUni
// AskUni creates the student when step 2 of Add Student passes, so a second send (or a student
// added by hand before) gets "Email already exists". Then the bot works on the student's own page
// (Users → Student → the student): Essential Documents tab for missing files, then the
// applications page → ADD APPLICATION → the same programme search and Apply as step 4.
export async function findStudent(page, portalUrl, email, log){
  if(!email) return null;
  await page.goto(portalUrl + "/users/student/list/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('a[href*="/users/student/"]').first().waitFor({ timeout: 20000 }).catch(() => {});
  const look = () => page.evaluate((em) => {
    em = em.toLowerCase();
    const hits = Array.from(document.querySelectorAll("a, span, p, div, td, h6"))
      .filter(e => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === em);
    for(const e of hits){
      // climb to the row that holds exactly one student link
      for(let r = e, i = 0; r && i < 10; r = r.parentElement, i++){
        const ids = new Set(Array.from(r.querySelectorAll('a[href*="/users/student/"]'))
          .map(a => ((a.getAttribute("href") || "").match(/\/users\/student\/(\d+)/) || [])[1]).filter(Boolean));
        if(ids.size === 1) return Array.from(ids)[0];
        if(ids.size > 1) break;
      }
    }
    return null;
  }, email).catch(() => null);
  let id = await look();
  if(!id){
    // not on the first page: use the Email filter
    try{
      await page.getByText(/^\s*Filters\s*$/i).first().click({ timeout: 5000 });
      const box = await firstVisible(page.getByLabel(/^\s*e-?mail\s*$/i));
      if(box){ await box.fill(email); await box.press("Enter"); await page.waitForTimeout(3500); id = await look(); }
    }catch(_){}
  }
  log && log("info", id ? `found this student on AskUni already (student #${id})` : "this student is not on AskUni yet");
  return id;
}
export async function existingStudent(page, portalUrl, id, d, log, onStep){
  onStep && await onStep(3, STEP_NAMES[3]);
  await page.goto(`${portalUrl}/users/student/${id}/account/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Essential Documents is the third tab (person, info, essential documents, documents, applications, notes)
  const tabs = page.getByRole("tab");
  await tabs.first().waitFor({ timeout: 20000 }).catch(() => {});
  if((await tabs.count()) >= 5){
    await tabs.nth(2).click({ timeout: 10000 }).catch(() => {});
    await page.getByText(/^\s*Essential Documents\s*$/i).first().waitFor({ timeout: 15000 }).catch(() => {});
    for(const [label, file] of [["Passport", d.files.passport], ["Diploma", d.files.diploma], ["Transcript", d.files.transcript]]){
      if(!file) continue;
      // a file AskUni already has shows a download icon next to the paperclip; skip those
      const box = await fieldBox(page.locator("body"), label);
      const icons = box ? await box.locator("svg").count().catch(() => 0) : 0;
      if(icons >= 2){ log && log("info", `${label}: already on AskUni`); continue; }
      await uploadFile(page, label, file, log);
      await page.waitForTimeout(1500);
    }
  }else log && log("warn", "the student's page tabs look different — skipped the documents");
  onStep && await onStep(4, STEP_NAMES[4]);
  await page.goto(`${portalUrl}/users/student/${id}/applications/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const add = page.getByRole("button", { name: /add application/i }).first();
  await add.waitFor({ timeout: 20000 }).catch(() => {});
  if(!(await add.isVisible().catch(() => false))) throw new StepBlocked(STEP_NAMES[4], [], "The ADD APPLICATION button isn't on the student's page.");
  await add.click();
  let search = null;
  for(let i = 0; i < 20 && !search; i++){ search = await programSearch(page); if(!search) await page.waitForTimeout(1000); }
  if(!search){
    const said = await whatPageSays(page);
    log && log("info", `ADD APPLICATION opened: ${said.dialog || said.alerts.join(" | ")}`);
    throw new StepBlocked(STEP_NAMES[4], [], "ADD APPLICATION opened a window the bot doesn't know yet.");
  }
  const out = await step4(page, d, log);
  return { askuni_student_id: out.askuni_student_id || id };
}
