import test from "node:test";
import assert from "node:assert/strict";
import { baseReasonText, goalBranchStanding, repositoryName } from "../src/branches";

test("the base branch says in one sentence which rule chose it", () => {
  assert.equal(
    baseReasonText({ branch: "dev", reason: { kind: "merged-pull-requests", count: 34, of: 40 } }),
    "34 of your last 40 merged pull requests went to dev.",
  );
  assert.equal(
    baseReasonText({ branch: "dev", reason: { kind: "merged-pull-requests", count: 1, of: 1 } }),
    "Your last merged pull request went to dev.",
  );
  assert.equal(baseReasonText({ branch: "develop", reason: { kind: "integration-branch" } }), "Your repository has a develop branch.");
  assert.equal(baseReasonText({ branch: "main", reason: { kind: "default-branch" } }), "main is the repository's default branch.");
  assert.equal(baseReasonText({ branch: "main", reason: { kind: "fallback" } }), "No other branch fits, so main.");
  assert.equal(baseReasonText({ branch: "staging", reason: { kind: "chosen" } }), "You chose staging.");
});

test("a goal's branch row says where its work goes, and when a fresh start is offered", () => {
  assert.deepEqual(goalBranchStanding({}, false, "dev"), { kind: "on-first-start", from: "dev" });
  assert.deepEqual(goalBranchStanding({ baseBranch: "staging" }, false, "dev"), { kind: "on-first-start", from: "staging" });
  assert.deepEqual(goalBranchStanding({ branch: "epic/ep-02-telligence" }, false, "dev"), {
    kind: "unused",
    branch: "epic/ep-02-telligence",
  });
  assert.deepEqual(goalBranchStanding({ branch: "feat/export" }, true, "dev"), { kind: "working", branch: "feat/export" });
});

test("the project switcher names the repository: owner/name on GitHub, else the folder", () => {
  assert.equal(repositoryName({ folder: "/Users/a/code/memcode", github: "https://github.com/syncable-dev/memcode" }), "syncable-dev/memcode");
  assert.equal(repositoryName({ folder: "/Users/a/code/notes/" }), "notes");
  assert.equal(repositoryName({ folder: "C:\\Users\\a\\code\\api" }), "api");
});
