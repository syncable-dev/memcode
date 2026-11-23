import test from "node:test";
import assert from "node:assert/strict";
import { fileTypeOf, isForPeople } from "../runtime/sharing/cards/files";

test("documents, images, sheets and slides a worker makes are for people, and shared on their own", () => {
  for (const name of [
    "verification.md",
    "notes.txt",
    "report.pdf",
    "export-report.html",
    "totals.csv",
    "screen.png",
    "photo.JPG",
    "diagram.svg",
    "plan.docx",
    "budget.xlsx",
    "pitch.pptx",
  ])
    assert.equal(isForPeople(name), true, name);
});

test("code and data files are not shared unless someone shares them", () => {
  for (const name of ["count.sh", "export.ts", "data.json", "fix.patch", "Makefile"])
    assert.equal(isForPeople(name), false, name);
});

test("Word, Excel and PowerPoint files are shared under their own types", () => {
  assert.equal(
    fileTypeOf("plan.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(
    fileTypeOf("budget.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(
    fileTypeOf("pitch.pptx"),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
});
