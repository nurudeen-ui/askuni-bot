// scan.js — Orbuni ⇄ AskUni: reads AskUni's own pages (read only, never clicks Save/Apply/Delete).
// Phase 1 (2 Oct 2026): record what every important page looks like so the readers can be built exactly.
// The raw pages go to the private table askuni_scans (service role only).
const MAX_TEXT = 15000;
const KEEP_PER_URL = 3;
const WANTED_LINK = /(commission|payout|payment|wallet|withdraw|invoice|earning|report|notification|message|document|offer|dashboard|application|student|balance|transaction)/i;
const NEVER = /(logout|log-out|signout|sign-out|delete|remove|add-student|create)/i;

async function snapshot(page){
  return await page.evaluate((MAX) => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const tables = [];
    document.querySelectorAll("table, [role=grid], [role=table]").forEach((tb, ti) => {
      if(ti > 4) return;
      const isT = tb.tagName === "TABLE";
      const headers = Array.from(tb.querySelectorAll(isT ? "thead th" : "[role=columnheader]")).map(h => clean(h.innerText));
      const rows = Array.from(tb.querySelectorAll(isT ? "tbody tr" : "[role=row]")).slice(0, 60).map(r => ({
        cells: Array.from(r.querySelectorAll(isT ? "td" : "[role=cell]")).map(c => clean(c.innerText)).slice(0, 20),
        links: Array.from(r.querySelectorAll("a[href]")).map(a => a.getAttribute("href")).slice(0, 4),
      })).filter(r => r.cells.length);
      tables.push({ headers, rows });
    });
    const links = Array.from(document.querySelectorAll("a[href]")).map(a => ({ href: a.getAttribute("href"), text: clean(a.innerText).slice(0, 80) }))
      .filter(l => l.href && !l.href.startsWith("javascript") && !l.href.startsWith("#")).slice(0, 150);
    return { title: document.title, text: clean(document.body.innerText).slice(0, MAX), tables, links };
  }, MAX_TEXT);
}

async function visit(page, url){
  try{
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return await snapshot(page);
  }catch(e){ return { error: String(e && e.message || e).split("\n")[0] }; }
}

export async function runScan(page, portal, sb, log){
  const seen = new Set(); const out = [];
  const origin = new URL(portal).origin;
  const record = async (url, kind) => {
    const key = url.replace(/[#?].*$/, "") + (url.includes("?") ? "?" + url.split("?")[1] : "");
    if(seen.has(key)) return null; seen.add(key);
    const snap = await visit(page, url);
    if(snap.error){ log && log("warn", `scan: ${url} → ${snap.error}`); return null; }
    const { error } = await sb.from("askuni_scans").insert({ url, kind, title: snap.title, page_text: snap.text, tables: snap.tables, links: snap.links });
    if(error) log && log("warn", `scan: couldn't save ${url}: ${error.message}`);
    out.push({ url, kind, snap });
    // keep only the newest few of each page
    const { data: old } = await sb.from("askuni_scans").select("id").eq("url", url).order("scanned_at", { ascending: false }).range(KEEP_PER_URL, 200);
    if(old && old.length) await sb.from("askuni_scans").delete().in("id", old.map(o => o.id));
    return snap;
  };
  const list = await record(portal + "/users/student/list/", "student-list");
  await record(portal + "/application/commissions/?only_my_commissions=true&activeTab=all", "commissions");
  // every menu / page link that looks relevant (read only; skips anything that could change data)
  const navLinks = [];
  for(const o of out) for(const l of (o.snap.links || [])){
    try{
      const u = new URL(l.href, origin); if(u.origin !== origin) continue;
      if(NEVER.test(u.pathname) || !(WANTED_LINK.test(u.pathname) || WANTED_LINK.test(l.text))) continue;
      if(/\/users\/student\/\d+/.test(u.pathname)) continue;
      navLinks.push(u.toString());
    }catch(_){}
  }
  for(const u of Array.from(new Set(navLinks)).slice(0, 12)) await record(u, "menu-page");
  // a few students: their application pages show offers and missing documents
  const studentUrls = [];
  if(list) for(const t of list.tables || []) for(const r of t.rows) for(const h of r.links || []){
    const m = /\/users\/student\/(\d+)/.exec(h || ""); if(m) studentUrls.push(m[1]);
  }
  for(const id of Array.from(new Set(studentUrls)).slice(0, 4)){
    await record(`${portal}/users/student/${id}/applications/`, "student-applications");
    await record(`${portal}/users/student/${id}/`, "student-profile");
  }
  log && log("info", `scan: saved ${out.length} pages`);
  return out.length;
}
