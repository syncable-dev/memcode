import test from "node:test";
import assert from "node:assert/strict";
import type { Artifact, WorkItem } from "../src/shared";
import type { SharedCardResult } from "../src/sharing";
import {
  cardFileList,
  cardRunElsewhere,
  isUnfetchedSharedFile,
  onlyItsOwnerContinues,
  runElsewhereNote,
  runElsewhereStanding,
  sendElsewhereLabel,
  sharedFilesToFetch,
} from "../src/sharing-cards";
import { task } from "./support/board-computers";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RemoteWorker } from "../src/components/RemoteWorker";

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
  assert.equal(runElsewhereNote(owner), "Continue the worker on your Mac…");
  assert.equal(sendElsewhereLabel(owner), "Send to your Mac");
  assert.equal(
    onlyItsOwnerContinues(owner),
    "Only Alex Holm can continue this worker. Comment on the card to reach them.",
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

test("the panel for a run from a shared project's card speaks of the project, and Team Sync's keeps its words", () => {
  const owner = cardRunElsewhere(withRun())!;
  const text = (scope?: "project") =>
    renderToStaticMarkup(
      createElement(RemoteWorker, { owner, offline: false, scope }),
    ).replace(/<[^>]+>/g, " ");
  const project = text("project");
  assert.match(project, /SHARED/);
  assert.match(
    project,
    /The conversation stays with Alex Holm\. Everyone on the project sees its summaries, changes and review\. It runs on Mac\./,
  );
  assert.doesNotMatch(project, /\bteam\b/i);
  const team = text();
  assert.match(team, /TEAM/);
  assert.match(
    team,
    /Conversation and review shared with the team\. Execution stays on\s+Mac\./,
  );
});

test("someone else's run reads, in place of its conversation, how it stands until its summary is in", () => {
  const owner = { name: "Alex Holm", device: "Mac" };
  const session = (changes: Record<string, unknown>) =>
    ({ state: "running", messages: [], ...changes }) as never;
  assert.equal(
    runElsewhereStanding(owner, session({})),
    "Alex Holm is working on this on their Mac. A summary of the work shows here when it's ready for review.",
  );
  const done = [{ text: "Done.", at, by: "Alex Holm", device: "Mac" }];
  assert.equal(
    runElsewhereStanding(owner, session({ state: "finished", summaries: done })),
    undefined,
  );
  assert.equal(
    runElsewhereStanding(owner, session({ summaries: done })),
    "Alex Holm is working on this again on their Mac. A new summary shows here when it's ready for review.",
  );
  assert.equal(
    runElsewhereStanding(owner, session({ state: "finished" })),
    "Alex Holm's worker finished on their Mac without a summary. What it changed and made is in the Changes and Artifacts tabs.",
  );
  assert.equal(
    runElsewhereStanding(owner, session({ state: "failed" })),
    "Alex Holm's worker on their Mac stopped before it finished.",
  );
  assert.equal(
    runElsewhereStanding(owner, session({ state: "stopped" })),
    "Alex Holm's worker on their Mac stopped before it finished.",
  );
});

test("someone else's run shows the request first, then how it stands", async () => {
  const { OthersRun } = await import("../src/components/OthersRun");
  const markup = renderToStaticMarkup(
    createElement(OthersRun, {
      owner: { name: "Alex Holm", device: "Mac" },
      request: "Count the nonblank lines read from standard input.",
      session: { state: "running", messages: [] } as never,
      onOpenLink: () => {},
    }),
  );
  const text = markup.replace(/<[^>]+>/g, " ");
  assert.match(text, /Request\s+Count the nonblank lines read from standard input\./);
  assert.match(text, /Alex Holm is working on this on their Mac/);
  assert.doesNotMatch(text, /SUMMARY/);
  assert.ok(
    text.indexOf("Count the nonblank") < text.indexOf("is working on this"),
  );
});

test("someone else's run lists a summary for each round of work, oldest first, with who and when", async () => {
  const { OthersRun } = await import("../src/components/OthersRun");
  const later = "2026-11-22T11:00:00.000Z";
  const text = renderToStaticMarkup(
    createElement(OthersRun, {
      owner: { name: "Alex Holm", device: "Mac" },
      request: "Export the report.",
      session: {
        state: "running",
        messages: [],
        summaries: [
          { text: "Added the CSV export.", at, by: "Dana Lee", device: "Windows" },
          { text: "Added TSV too.", at: later, by: "Alex Holm", device: "Mac" },
        ],
      } as never,
      onOpenLink: () => {},
    }),
  ).replace(/<[^>]+>/g, " ");
  assert.equal(text.match(/SUMMARY/g)?.length, 2);
  assert.match(text, /Dana Lee · Windows · /);
  assert.ok(text.indexOf("Added the CSV export.") < text.indexOf("Added TSV too."));
  assert.ok(text.indexOf("Added TSV too.") < text.indexOf("working on this again"));
});

test("on the computer that ran the worker, the card says documents and images go to everyone by themselves", async () => {
  const { ShareFromCard } = await import("../src/components/ShareFromCard");
  const file = (name: string) =>
    ({ id: name, name, kind: "text", path: `/x/${name}`, taskId: "t", projectId: "p", createdAt: at, source: "codex" }) as Artifact;
  const text = renderToStaticMarkup(
    createElement(ShareFromCard, {
      projectName: "Website",
      artifacts: [file("verification.md"), file("count.sh")],
      sharedNames: new Set(["verification.md"]),
      busy: "",
      onShare: () => {},
    }),
  ).replace(/<[^>]+>/g, " ");
  assert.match(
    text,
    /Documents and images the worker makes are shared with everyone on\s+Website\s+when its run finishes\. Share any other file yourself\./,
  );
  assert.match(text, /verification\.md\s+Shared/);
  assert.match(text, /count\.sh\s+Share/);
});

test("a file shared again after a later round is listed once, as its newest version", () => {
  const later = "2026-11-22T11:00:00.000Z";
  const card = withRun({
    sharedResults: [
      result({ id: "old", name: "verification.md", sharedAt: at }),
      result({ id: "new", name: "verification.md", sharedAt: later }),
      result({ id: "other", name: "verification.md", sharedBy: "Dana Lee" }),
    ],
  });
  const listed = (own: Artifact[]) =>
    cardFileList(card, own).map((file) => `${file.id} ${file.source}`);
  assert.deepEqual(listed([]), ["shared:new Alex Holm", "shared:other Dana Lee"]);
  // The older version was opened before the newer one came: only the newer one is listed.
  const openedOld = {
    ...sharedFilesToFetch(withRun({ sharedResults: [card.sharedResults![0]] }), [])[0],
    path: "/profile/captures/task-1/shared-old-verification.md",
  };
  assert.deepEqual(listed([openedOld]), ["shared:new Alex Holm", "shared:other Dana Lee"]);
});
