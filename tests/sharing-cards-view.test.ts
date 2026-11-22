import test from "node:test";
import assert from "node:assert/strict";
import type { Artifact, WorkItem } from "../src/shared";
import type { SharedCardResult } from "../src/sharing";
import {
  cardRunElsewhere,
  isUnfetchedSharedFile,
  runElsewhereNote,
  sharedFilesToFetch,
} from "../src/sharing-cards";
import { task } from "./support/board-computers";

const at = "2026-11-22T10:00:00.000Z";
const result = (changes: Partial<SharedCardResult> = {}): SharedCardResult => ({
  id: "r1",
  name: "export-report.html",
  mime: "text/html",
  sha256: "a".repeat(64),
  size: 120,
  kind: "report",
  sharedBy: "Alex Holm",
  sharedAt: at,
  sharedHere: false,
  ...changes,
});
const withRun = (changes: Partial<WorkItem> = {}): WorkItem =>
  task("local-web", "task-1", {
    sharedFromLog: true,
    sharedSession: {
      id: "run-1",
      storyId: "task-1",
      epoch: 1,
      revision: 3,
      sequence: 3,
      owner: { memberId: "m", name: "Alex Holm", deviceId: "d", device: "Mac" },
      updatedAt: at,
      harness: "codex",
      state: "running",
      startedAt: at,
      messages: [],
    },
    ...changes,
  });

test("a run from another computer's card log is shown as a worker elsewhere, by its owner's name and computer", () => {
  const owner = cardRunElsewhere(withRun())!;
  assert.equal(owner.name, "Alex Holm");
  assert.equal(owner.device, "Mac");
  assert.equal(owner.local, false);
  assert.equal(owner.session?.state, "running");
  assert.equal(owner.claim.attemptId, "run-1");
  assert.equal(
    runElsewhereNote(owner),
    "This worker runs on Alex Holm's Mac. Comment on the card to reach them.",
  );
  // A card without a run from elsewhere, or a Team Sync session, is not one.
  assert.equal(cardRunElsewhere(task("local-web", "task-2")), undefined);
  assert.equal(
    cardRunElsewhere(withRun({ sharedFromLog: undefined })),
    undefined,
  );
});

test("files shared from elsewhere are listed until fetched; shared changes and this computer's own are not", () => {
  const card = withRun({
    sharedResults: [
      result(),
      result({
        id: "r2",
        name: "shot.png",
        mime: "image/png",
        kind: "artifact",
      }),
      result({ id: "r3", name: "MC-001-changes.json", kind: "patch" }),
      result({ id: "r4", name: "mine.html", sharedHere: true }),
    ],
  });
  const listed = sharedFilesToFetch(card, []);
  assert.deepEqual(
    listed.map((file) => [file.name, file.kind, file.purpose, file.source]),
    [
      ["export-report.html", "html", "report", "Alex Holm"],
      ["shot.png", "image", "deliverable", "Alex Holm"],
    ],
  );
  assert.ok(listed.every(isUnfetchedSharedFile));
  const fetched: Artifact = {
    ...listed[0],
    path: "/profile/captures/task-1/shared-x-export-report.html",
  };
  assert.equal(isUnfetchedSharedFile(fetched), false);
  assert.deepEqual(
    sharedFilesToFetch(card, [fetched]).map((file) => file.name),
    ["shot.png"],
  );
});
