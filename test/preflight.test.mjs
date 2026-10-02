// npm test  — checks preflight.js without AskUni, Supabase or a browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preflight, fileKind, planSummary } from "../preflight.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-"));
const write = async (name, bytes) => { const p = path.join(tmp, name); await fs.writeFile(p, bytes); return p; };
const pdf = await write("passport.pdf", Buffer.from("%PDF-1.4 test"));
const jpg = await write("diploma.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
const png = await write("transcript.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
const docx = await write("transcript.docx", Buffer.from("PK\u0003\u0004 word file"));
const empty = await write("empty.pdf", Buffer.alloc(0));

const good = () => ({
  first_name: "Abubakar", last_name: "Yaya", email: "test@example.com", gender: "male", phone: "+2348000000000",
  passport_number: "A1234567", date_of_birth: "2003-04-05", nationality: "Nigerian", country: null, country_of_birth: null,
  city: "Kano", address_line: "1 Test Road", mother_name: "M", father_name: "F",
  passport_expiry: "2030-01-01", passport_issue_date: "2020-01-01",
  course: "Computer Engineering", university: "Test University",
  files: { photo: jpg, passport: pdf, diploma: jpg, transcript: png }, fileProblems: {},
});

test("file types are read from the bytes, not the name", () => {
  assert.equal(fileKind(Buffer.from("%PDF-1.7")), "PDF");
  assert.equal(fileKind(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), "JPG");
  assert.equal(fileKind(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "PNG");
  assert.equal(fileKind(Buffer.from("PK\u0003\u0004")), null);
});

test("a complete file is ready to send; residence and birth country fall back to nationality", async () => {
  const r = await preflight(good());
  assert.equal(r.ok, true, r.blockers.join("; "));
  assert.equal(r.plan.length, 4);
  const step2 = r.plan[1].would_fill;
  assert.match(step2.find(l => l.field === "Country of Residence").note, /nationality/);
  assert.equal(planSummary(r).length, 4);
});

test("missing document, wrong file type and empty file each stop the send with a plain reason", async () => {
  const d = good();
  d.files.passport = null; d.fileProblems.passport = "missing";
  d.files.transcript = docx;
  d.files.diploma = empty;
  const r = await preflight(d);
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some(b => /no passport file/.test(b)));
  assert.ok(r.blockers.some(b => /transcript file isn't a PDF, JPG or PNG/.test(b)));
  assert.ok(r.blockers.some(b => /diploma file is empty/.test(b)));
});

test("a file that is in Orbuni but won't download says so", async () => {
  const d = good(); d.files.passport = null; d.fileProblems.passport = "couldn't download x: Object not found";
  const r = await preflight(d);
  assert.ok(r.blockers.some(b => /couldn't be downloaded \(couldn't download x: Object not found\)/.test(b)));
});

test("required fields block, optional ones only warn", async () => {
  const d = good(); d.gender = ""; d.phone = "123"; d.mother_name = ""; d.date_of_birth = "5 April";
  const r = await preflight(d);
  assert.ok(r.blockers.some(b => /Gender is empty/.test(b)));
  assert.ok(r.blockers.some(b => /Mobile Phone is too short/.test(b)));
  assert.ok(r.blockers.some(b => /Birth Date isn't a full date/.test(b)));
  assert.ok(r.warnings.some(w => /Mother Name is empty/.test(w)));
  assert.ok(!r.blockers.some(b => /Mother/.test(b)));
});

test("resuming at step 3 only checks steps 3 and 4", async () => {
  const d = good(); d.gender = ""; d.files.transcript = null;
  const r = await preflight(d, 3);
  assert.deepEqual(r.plan.map(p => p.step), ["03 Documents", "04 Apply"]);
  assert.ok(!r.blockers.some(b => /Gender/.test(b)));
  assert.ok(r.blockers.some(b => /transcript/.test(b)));
});

test("the report never contains the student's personal values", async () => {
  const text = JSON.stringify(await preflight(good()));
  for(const secret of ["A1234567", "2003-04-05", "+2348000000000", "test@example.com", "1 Test Road"]) assert.ok(!text.includes(secret), secret);
});
