// sync.js — Orbuni ⇄ AskUni: reads AskUni's Applications and Commissions pages and feeds Orbuni.
// Read only on AskUni. On the Orbuni side it
//   • moves each matched application to the status AskUni shows (Orbuni's own database triggers then
//     tell the student: dashboard alert, email — and the team/partner alerts),
//   • records every commission in the Finance dashboard (pending until AskUni shows it paid),
//   • logs anything it does not recognise in askuni_events so the rules can be extended.

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// AskUni status text -> Orbuni's application status. Unknown words return null (team is told, student is not).
export function mapStatus(raw){
  const t = norm(raw);
  if(!t) return null;
  if(/missing doc|document/.test(t)) return "docs_needed";
  if(/reject|declin|denied|not accepted/.test(t)) return "rejected";
  if(/withdraw|cancel|dropp/.test(t)) return "withdrawn";
  if(/acceptance/.test(t)) return "offer_accepted";
  if(/enrol|register/.test(t)) return "enrolled";
  if(/visa/.test(t)) return "visa_stage";
  if(/deposit|paid/.test(t)) return "deposit_paid";
  if(/offer|accepted|admitted|admission/.test(t)) return "offer_received";
  if(/on process|processing|in process|pending|review|submitted|applied/.test(t)) return "in_review";
  return null;
}
const LATER = new Set(["offer_received", "offer_accepted", "deposit_paid", "visa_stage", "enrolled"]);

// "USMAN SHEHU MAISANGO Xr1bkjLG9F NU2026-82334"  ->  { name, code, apply_code }
export function splitStudentCell(cell){
  const t = String(cell || "").replace(/\s+/g, " ").trim();
  const words = t.split(" "); const name = [];
  for(const w of words){
    if(!/^[A-Z][A-Z'’.\-]*$/.test(w) || w === "ID") break;   // a code (digits / mixed case) or "ID" ends the name
    name.push(w);
  }
  const rest = words.slice(name.length).join(" ");
  return { name: (name.length ? name.join(" ") : t), code: rest || null, apply_code: null };
}
export const appIdFromLinks = (links) => {
  for(const l of links || []){ const m = /\/application\/detail\/(\d+)\//.exec(l || ""); if(m) return Number(m[1]); }
  return null;
};
const money = (s) => { const n = parseFloat(String(s || "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };

// Reads every page of one AskUni list (up to 40 pages of the biggest page size).
async function readAll(page, url, log){
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("table, [role=grid], [role=table]").first().waitFor({ timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // ask for the biggest page size
  try{
    const sel = page.locator(".MuiTablePagination-select, [aria-label*='Rows per page' i]").first();
    if(await sel.count()){
      await sel.click({ timeout: 3000 });
      const opts = page.locator("[role=option], li[data-value]");
      await opts.first().waitFor({ timeout: 3000 });
      const texts = await opts.allTextContents();
      let best = -1, bi = -1; texts.forEach((t, i) => { const n = parseInt(t, 10); if(n > best){ best = n; bi = i; } });
      if(bi >= 0){ await opts.nth(bi).click({ timeout: 3000 }); await page.waitForTimeout(1500); }
    }
  }catch(_){ await page.keyboard.press("Escape").catch(() => {}); }
  const all = []; let headers = [];
  for(let pg = 0; pg < 40; pg++){
    const got = await page.evaluate(() => {
      const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
      const tb = document.querySelector("table, [role=grid], [role=table]"); if(!tb) return { headers: [], rows: [] };
      const isT = tb.tagName === "TABLE";
      const headers = Array.from(tb.querySelectorAll(isT ? "thead th" : "[role=columnheader]")).map(h => clean(h.innerText).toUpperCase());
      const rows = Array.from(tb.querySelectorAll(isT ? "tbody tr" : "[role=row]")).map(r => ({
        cells: Array.from(r.querySelectorAll(isT ? "td" : "[role=cell]")).map(c => clean(c.innerText)),
        links: Array.from(r.querySelectorAll("a[href]")).map(a => a.getAttribute("href")),
      })).filter(r => r.cells.length > 2);
      return { headers, rows };
    });
    if(got.headers.length) headers = got.headers;
    const before = all.length;
    for(const r of got.rows){ const key = r.cells.join("|") + "|" + (r.links || []).join(","); if(!all.some(x => x.key === key)) all.push({ ...r, key }); }
    const next = page.locator("button[aria-label='Go to next page']:not([disabled]), [aria-label='Next page']:not([disabled])").first();
    if(!(await next.count()) || all.length === before) break;
    await next.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  log && log("info", `sync: read ${all.length} rows from ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  return { headers, rows: all };
}
const col = (headers, row, name) => { const i = headers.indexOf(name); return i >= 0 ? row.cells[i] : undefined; };

async function matchApplication(sb, studentName, program){
  const parts = String(studentName || "").trim().split(/\s+/);
  if(parts.length < 2) return null;
  // names are matched on all the words, in any order, so "USMAN SHEHU MAISANGO" finds first "Usman" + last "Shehu Maisango"
  const { data: profs } = await sb.from("profiles").select("id, first_name, last_name").eq("role", "student");
  const want = norm(studentName).split(" ").sort().join(" ");
  const hits = (profs || []).filter(p => norm((p.first_name || "") + " " + (p.last_name || "")).split(" ").sort().join(" ") === want);
  if(hits.length !== 1) return null;
  const { data: apps } = await sb.from("applications").select("id, status, programmes!inner(course, universities!inner(name))").eq("profile_id", hits[0].id).neq("status", "withdrawn");
  if(!apps || !apps.length) return { profile_id: hits[0].id, application: null };
  const P = norm(program);
  const scored = apps.map(a => {
    const c = norm(a.programmes && a.programmes.course), u = norm(a.programmes && a.programmes.universities && a.programmes.universities.name);
    return { a, score: (c && P.includes(c) ? 2 : 0) + (u && P.includes(u) ? 1 : 0) };
  }).sort((x, y) => y.score - x.score);
  const top = scored[0];
  return { profile_id: hits[0].id, application: top.score >= 2 ? top.a : (apps.length === 1 ? apps[0] : null) };
}

export async function runSync(page, portal, sb, log){
  const stats = { applications: 0, changed: 0, commissions: 0, finance_new: 0, unknown: 0 };
  // Safety: do nothing until the sync tables exist, so nothing is ever written twice.
  const probe = await sb.from("askuni_applications").select("askuni_app_id").limit(1);
  if(probe.error){ log && log("warn", "sync: tables not ready yet (" + probe.error.message + ") — skipping"); return { skipped: true }; }
  const event = (kind, detail) => sb.from("askuni_events").insert({ kind, detail }).then(() => {}, () => {});

  // ---- applications
  const apps = await readAll(page, portal + "/application/list/", log);
  for(const r of apps.rows){
    const askId = appIdFromLinks(r.links); if(!askId) continue;
    const s = splitStudentCell(col(apps.headers, r, "STUDENT"));
    const program = col(apps.headers, r, "PROGRAM") || "";
    const status = col(apps.headers, r, "STATUS") || "";
    const { data: prev } = await sb.from("askuni_applications").select("askuni_status, application_id, mapped_status").eq("askuni_app_id", askId).maybeSingle();
    const m = await matchApplication(sb, s.name, program);
    const application_id = (m && m.application && m.application.id) || (prev && prev.application_id) || null;
    const row = { askuni_app_id: askId, student_name: s.name, program, program_code: s.code, apply_code: s.apply_code, askuni_status: status,
      season: col(apps.headers, r, "SEASON") || null, created_on: col(apps.headers, r, "CREATED DATE") || null,
      modified_on: col(apps.headers, r, "MODIFIED DATE") || null, authorized_user: col(apps.headers, r, "AUTHORIZED USER") || null,
      application_id, last_seen: new Date().toISOString() };
    const changed = !prev || prev.askuni_status !== status;
    if(changed) row.last_changed = new Date().toISOString();
    const up = await sb.from("askuni_applications").upsert(row, { onConflict: "askuni_app_id" });
    if(up.error){ log && log("warn", "sync: couldn't save an application: " + up.error.message); continue; }
    stats.applications++;
    if(!changed) continue;
    stats.changed++;
    const mapped = mapStatus(status);
    await event("status", { askuni_app_id: askId, student: s.name, from: prev && prev.askuni_status, to: status, mapped, matched: !!application_id });
    if(!mapped){ stats.unknown++; await event("unknown_status", { status, student: s.name }); }
    // first time we ever see an application we only record it, so old history never floods students
    if(!prev) continue;
    if(mapped && application_id && m && m.application){
      const cur = m.application.status;
      const skip = LATER.has(cur) && ["docs_needed", "in_review"].includes(mapped);
      if(!skip && cur !== mapped){
        const u = await sb.from("applications").update({ status: mapped, askuni_synced_at: new Date().toISOString() }).eq("id", application_id);
        if(u.error) log && log("warn", "sync: couldn't move an application: " + u.error.message);
        else { await sb.from("askuni_applications").update({ mapped_status: mapped }).eq("askuni_app_id", askId); log && log("info", `sync: ${s.name} → ${mapped}`); }
      }
    }
  }

  // ---- commissions → Finance
  const com = await readAll(page, portal + "/application/commissions/?only_my_commissions=true&activeTab=all", log);
  for(const r of com.rows){
    const askId = appIdFromLinks(r.links);
    const amount = money(col(com.headers, r, "AMOUNT")); if(amount == null || !askId) continue;
    const pct = money(col(com.headers, r, "COMMISSION")) || 0;
    const remaining = money(col(com.headers, r, "REMAINING"));
    const status = col(com.headers, r, "STATUS") || "";
    const student = col(com.headers, r, "STUDENT") || "";
    const received = remaining == null ? (/^paid$/i.test(status.trim()) ? amount : 0) : Math.max(0, Math.round((amount - remaining) * 100) / 100);
    const key = { askuni_app_id: askId, amount, commission_pct: pct };
    const { data: prev } = await sb.from("askuni_commissions").select("finance_tx_id").match(key).maybeSingle();
    const { data: link } = await sb.from("askuni_applications").select("application_id").eq("askuni_app_id", askId).maybeSingle();
    let txId = prev && prev.finance_tx_id;
    // The Finance dashboard counts every income row, so a commission only goes in once AskUni shows money paid.
    if(received > 0){
      const desc = `AskUni commission — ${student} (${pct}%) · application ${askId}`;
      if(!txId){
        const ins = await sb.from("finance_transactions").insert({ kind: "income", direction: "in", amount: received, currency: "USD", status: "paid",
          application_id: (link && link.application_id) || null, description: desc,
          occurred_on: new Date().toISOString().slice(0, 10), source: "automatic" }).select("id").single();
        if(ins.error){ log && log("warn", "sync: couldn't record a commission: " + ins.error.message); continue; }
        txId = ins.data.id; stats.finance_new++;
      }else{
        await sb.from("finance_transactions").update({ amount: received, status: "paid" }).eq("id", txId);
      }
    }
    await sb.from("askuni_commissions").upsert({ ...key, student_name: student, app_status: col(com.headers, r, "APPLICATION STATUS") || null,
      status, remaining, finance_tx_id: txId || null, application_id: (link && link.application_id) || null, last_seen: new Date().toISOString() }, { onConflict: "askuni_app_id,amount,commission_pct" });
    stats.commissions++;
  }
  log && log("info", `sync: ${JSON.stringify(stats)}`);
  return stats;
}
