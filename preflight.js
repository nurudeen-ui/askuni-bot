// preflight.js — checks a student's Orbuni file BEFORE anything is typed into AskUni.
//
// Why: AskUni creates the student's AskUni account as soon as step 1 is accepted. If a
// document is missing or unreadable, the old bot only found out at step 3 — after the
// account already existed — and pressing Send again made a second AskUni student.
// These checks run first, so a send that is bound to fail stops with a plain message
// and nothing is created in AskUni.
//
// Used two ways:
//   • by every real send (server.js runJob) — blockers stop the send, warnings are logged;
//   • by the dry run (POST /dry-run) — returns the full plan, nothing is sent.
// Field values are never put in the report, only "have it / missing", because the report
// ends up in logs.

import fs from "node:fs/promises";

// What AskUni's form asks for, step by step (see askuni-fill.js step1–step4).
// need: "block" = the send stops without it; "warn" = the send goes on, but AskUni may refuse.
export const PLAN = [
  { step: 1, name: "01 Account Details", items: [
    { key: "first_name", label: "First Name", need: "block" },
    { key: "last_name", label: "Last Name", need: "block" },
    { key: "email", label: "Email", need: "block", check: "email" },
    { key: "gender", label: "Gender", need: "block", check: "gender" },
    { key: "phone", label: "Mobile Phone", need: "block", check: "phone" },
    { file: "photo", label: "Profile Picture", need: "warn" },
  ], then: "press Next — AskUni creates the student's AskUni account at this point" },
  { step: 2, name: "02 Student Information", items: [
    { key: "passport_number", label: "Passport Number", need: "block" },
    { key: "date_of_birth", label: "Birth Date", need: "block", check: "date" },
    { key: "nationality", label: "Nationality", need: "block" },
    { key: "country_of_birth", label: "Country of Birth", need: "warn", fallback: "nationality" },
    { key: "country", label: "Country of Residence", need: "warn", fallback: "nationality" },
    { key: "city", label: "City of Residence", need: "warn" },
    { key: "address_line", label: "Address", need: "warn" },
    { key: "mother_name", label: "Mother Name", need: "warn" },
    { key: "father_name", label: "Father Name", need: "warn" },
    { key: "passport_expiry", label: "Passport Date of Expire", need: "warn", check: "date" },
    { key: "passport_issue_date", label: "Passport Date of Issue", need: "warn", check: "date" },
  ], then: "press Next" },
  { step: 3, name: "03 Documents", items: [
    { file: "passport", label: "Passport", need: "block" },
    { file: "diploma", label: "Diploma", need: "block" },
    { file: "transcript", label: "Transcript", need: "block" },
  ], then: "press Next" },
  { step: 4, name: "04 Apply", items: [
    { key: "course", label: "Programme", need: "block", show: true },
    { key: "university", label: "University", need: "block", show: true },
  ], then: "pick the result that names both, press the season button, confirm Apply, press Finish — this is the real submission" },
];

// AskUni's upload boxes take PDF and pictures. We look at the file's first bytes, not its name.
const KINDS = [
  { kind: "PDF", test: (b) => b.length >= 4 && b.toString("latin1", 0, 4) === "%PDF" },
  { kind: "JPG", test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: "PNG", test: (b) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
];
export function fileKind(buf){
  const hit = KINDS.find(k => k.test(buf));
  return hit ? hit.kind : null;
}
const MAX_MB = 10;   // AskUni's real limit is unknown; above this we only warn

const blank = (v) => v == null || String(v).trim() === "";
function badValue(check, v){
  const s = String(v).trim();
  if(check === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "doesn't look like an email address";
  if(check === "gender" && !["male", "female"].includes(s.toLowerCase())) return "must be Male or Female (AskUni has no other choice)";
  if(check === "phone" && s.replace(/\D/g, "").length < 7) return "is too short to be a phone number";
  if(check === "date" && !/^\d{4}-\d{2}-\d{2}/.test(s)) return "isn't a full date";
  return null;
}

async function checkFile(path){
  const st = await fs.stat(path);
  const fh = await fs.open(path, "r");
  try{
    const buf = Buffer.alloc(8);
    await fh.read(buf, 0, 8, 0);
    return { kind: fileKind(buf), mb: st.size / 1048576, empty: st.size === 0 };
  }finally{ await fh.close(); }
}

// data = what server.js prepare() returns (student fields, files, fileProblems).
// fromStep = the form step already on screen (0 = not started). Earlier steps are skipped.
export async function preflight(data, fromStep = 0){
  const blockers = [], warnings = [], plan = [];
  const problems = data.fileProblems || {};
  for(const s of PLAN){
    if(s.step < Math.max(1, fromStep)) continue;
    const lines = [];
    for(const it of s.items){
      let state = "ready", note = "";
      if(it.file){
        const path = data.files && data.files[it.file];
        if(!path){
          state = "missing";
          note = problems[it.file] === "missing" || !problems[it.file]
            ? `Orbuni has no ${it.label.toLowerCase()} file for this student — upload it in the student's Documents`
            : `the ${it.label.toLowerCase()} file is in Orbuni but couldn't be downloaded (${problems[it.file]}) — upload it again`;
        }else{
          const f = await checkFile(path).catch(() => null);
          if(!f || f.empty){ state = "problem"; note = `the ${it.label.toLowerCase()} file is empty or unreadable — upload it again`; }
          else if(!f.kind){ state = "problem"; note = `the ${it.label.toLowerCase()} file isn't a PDF, JPG or PNG — upload it again in one of those formats`; }
          else{
            note = f.kind + ", " + f.mb.toFixed(1) + " MB";
            if(f.mb > MAX_MB){ state = "warn"; note += ` — large file; AskUni may refuse it, a smaller copy is safer`; }
          }
        }
      }else{
        const v = data[it.key];
        if(blank(v)){
          if(it.fallback && !blank(data[it.fallback])){ state = "ready"; note = `not in Orbuni, will use ${it.fallback.replace(/_/g, " ")} instead`; }
          else{ state = "missing"; note = `${it.label} is empty in the student's Orbuni details`; }
        }else{
          const bad = it.check && badValue(it.check, v);
          if(bad){ state = "problem"; note = `${it.label} ${bad}`; }
          else if(it.show) note = String(v);
        }
      }
      if(state === "missing" || state === "problem"){
        (it.need === "block" ? blockers : warnings).push(note);
        if(it.need !== "block") state = "warn";
      }
      lines.push({ field: it.label, state, note });
    }
    plan.push({ step: s.name, would_fill: lines, then: s.then });
  }
  return { ok: blockers.length === 0, blockers, warnings, plan };
}

// One short line per step for the logs, e.g. "02 Student Information: 9 ready, 2 warn (Mother Name, Father Name)".
export function planSummary(report){
  return report.plan.map(p => {
    const by = (st) => p.would_fill.filter(l => l.state === st);
    const parts = [by("ready").length + " ready"];
    for(const st of ["warn", "missing", "problem"]){
      const l = by(st); if(l.length) parts.push(l.length + " " + st + " (" + l.map(x => x.field).join(", ") + ")");
    }
    return p.step + ": " + parts.join(", ");
  });
}
