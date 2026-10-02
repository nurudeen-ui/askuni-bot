// npm test — the parts of sync.js that turn AskUni's text into Orbuni values.
import test from "node:test";
import assert from "node:assert/strict";
import { mapStatus, splitStudentCell, appIdFromLinks } from "../sync.js";

test("every AskUni status seen so far maps to an Orbuni status", () => {
  assert.equal(mapStatus("OFFER SENT"), "offer_received");
  assert.equal(mapStatus("ACCEPTANCE LETTER SENT"), "offer_accepted");
  assert.equal(mapStatus("MISSING DOCUMENTS"), "docs_needed");
  assert.equal(mapStatus("DECLINED/REJECTED"), "rejected");
  assert.equal(mapStatus("DROPPED"), "withdrawn");
  assert.equal(mapStatus("ON PROCESS"), "in_review");
  assert.equal(mapStatus(""), null);
  assert.equal(mapStatus("SOMETHING NEW"), null);
});

test("the student name stops at AskUni's codes", () => {
  assert.equal(splitStudentCell("USMAN SHEHU MAISANGO Xr1bkjLG9F NU2026-82334").name, "USMAN SHEHU MAISANGO");
  assert.equal(splitStudentCell("NANZHWA AYO EUNICE QkRsUq0WC9 ID 4939").name, "NANZHWA AYO EUNICE");
  assert.equal(splitStudentCell("IMPANO CHARI 0vLUXlhHC5").name, "IMPANO CHARI");
});

test("the AskUni application number comes from the row's link", () => {
  assert.equal(appIdFromLinks(["/users/student/12/", "/application/detail/42401/"]), 42401);
  assert.equal(appIdFromLinks(["/users/student/12/"]), null);
});
