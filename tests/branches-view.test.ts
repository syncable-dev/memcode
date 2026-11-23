import test from "node:test";
import assert from "node:assert/strict";
import {
  folderStanding,
  goalBranchStanding,
  type RepositoryStatus,
} from "../src/branches";

const status = (changes: Partial<RepositoryStatus> = {}): RepositoryStatus => ({
  folder: "/work/memcode",
  remote: "origin",
  github: "https://github.com/syncable-dev/memcode",
  branch: "dev",
  changedFiles: 0,
  base: { branch: "dev", chosen: false },
  ahead: 0,
  behind: 0,
  branches: ["dev", "main"],
  ...changes,
});

test("the folder's branch reads as one sentence: where it is, how far behind, what is not committed", () => {
  assert.equal(folderStanding(status()), "The folder is on dev.");
  assert.equal(
    folderStanding(
      status({ branch: "epic/ep-02-telligence", behind: 230, changedFiles: 79 }),
    ),
    "The folder is on epic/ep-02-telligence, 230 commits behind dev. 79 changed files are not committed.",
  );
  assert.equal(
    folderStanding(status({ behind: 1, changedFiles: 1 })),
    "The folder is on dev, 1 commit behind dev. 1 changed file is not committed.",
  );
  assert.equal(folderStanding(status({ branch: null })), "The folder is on no branch.");
});

test("a goal says where its work goes, and offers a fresh start only before any worker used its branch", () => {
  assert.deepEqual(goalBranchStanding({}, false, "dev"), {
    text: "Gets its own branch from dev when work starts.",
    startFresh: false,
  });
  assert.deepEqual(goalBranchStanding({ baseBranch: "staging" }, false, "dev"), {
    text: "Gets its own branch from staging when work starts.",
    startFresh: false,
  });
  assert.deepEqual(
    goalBranchStanding({ branch: "epic/ep-02-telligence" }, false, "dev"),
    {
      text: "Set to epic/ep-02-telligence, which no worker here has used yet.",
      startFresh: true,
    },
  );
  assert.deepEqual(goalBranchStanding({ branch: "feat/export" }, true, "dev"), {
    text: "Work is on feat/export.",
    startFresh: false,
  });
});
