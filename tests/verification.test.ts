import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseCheckCounts,
  runTaskVerification,
  checkSourceBinding,
} from "../runtime/verification";
import type { AppState, WorkItem } from "../src/shared";
import type { TerminalManager } from "../runtime/terminals";

const sessionId = "00000000-0000-4000-8000-000000000001";
const marker = 'MEMCODE_CHECK_RESULT {"version":1,"passed":19,"failed":0}\n';
const chunk = (seq: number, text: string) => ({
  seq,
  data: Buffer.from(text).toString("base64"),
});
const reply = (after: number, text = marker, exitCode = 0) => ({
  session: { id: sessionId, status: "exited", seq: 1, exitCode },
  chunks: after < 1 ? [chunk(1, text)] : [],
  text: "UI text is deliberately not the machine-report channel.",
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-checks-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/main.mjs"), "export const value=1;\n");
  execFileSync("git", ["init", root], { stdio: "ignore", windowsHide: true });
  const task = {
    id: "task",
    projectId: "project",
    run: {
      state: "finished",
      workspace: root,
      changeRunId: "run",
      finishedSourceBinding: await checkSourceBinding(root),
    },
    changesRevision: "revision",
  } as unknown as WorkItem;
  assert.ok(task.run.finishedSourceBinding);
  const state = {
    projects: [{ id: "project", path: root }],
    tasks: [task],
  } as unknown as AppState;
  const input = {
    id: "task",
    program: "node",
    args: ["verifier.mjs"],
    format: "memcode-json" as const,
    timeoutMs: 1000,
  };
  let stopped = 0,
    observed = 0;
  const manager = (
    observe: (request: any, iteration: number) => any | Promise<any>,
  ) =>
    ({
      execute: async (_id: string, request: any) => {
        if (request.action === "start") return { session: { id: sessionId } };
        if (request.action === "stop") {
          stopped++;
          return {};
        }
        assert.equal(request.action, "observe");
        return observe(request, ++observed);
      },
    }) as unknown as TerminalManager;
  return {
    root,
    task,
    state,
    input,
    manager,
    stopped: () => stopped,
    observed: () => observed,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("only complete machine reports yield assertion counts, never prose or process success", () => {
  assert.deepEqual(parseCheckCounts("19 tests passed", "tap"), {
    passed: null,
    failed: null,
  });
  assert.deepEqual(
    parseCheckCounts(
      "TAP version 13\n# tests 4\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 0\n",
      "tap",
    ),
    { passed: 2, failed: 1 },
  );
  for (const report of [
    "TAP version 13\n# tests 4\n# pass 4\n# fail 0\n",
    "TAP version 13\n# tests 4\n# pass 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",
  ])
    assert.deepEqual(parseCheckCounts(report, "tap"), {
      passed: null,
      failed: null,
    });
  assert.deepEqual(parseCheckCounts(marker, "memcode-json"), {
    passed: 19,
    failed: 0,
  });
  for (const value of [
    marker + marker,
    "MEMCODE_CHECK_RESULT malformed\n",
    'MEMCODE_CHECK_RESULT {"version":1,"passed":-1,"failed":0}\n',
    'MEMCODE_CHECK_RESULT {"version":1,"passed":19.5,"failed":0}\n',
  ])
    assert.deepEqual(parseCheckCounts(value, "memcode-json"), {
      passed: null,
      failed: null,
    });
  assert.deepEqual(parseCheckCounts(marker, "exit-code"), {
    passed: null,
    failed: null,
  });
});

test("managed checks bind the exact finished worker source and consume full raw chunks rather than clipped UI text", async () => {
  const f = await fixture();
  try {
    const output = "diagnostic line\n".repeat(2000) + marker;
    const result = await runTaskVerification(
      () => f.state,
      f.manager((request) => reply(request.after, output)),
      f.input,
    );
    assert.equal(result.linked, true);
    assert.equal(result.passed, 19);
    assert.equal(result.exitCode, 0);
    assert.equal(f.stopped(), 0);
  } finally {
    await f.close();
  }
});

test("PTY titles never hide a complete TAP header or supply machine-report content", async () => {
  const tap =
    "TAP version 13\r\n# tests 8\r\n# pass 8\r\n# fail 0\r\n# cancelled 0\r\n# skipped 0\r\n# todo 0\r\n";
  for (const title of [
    "\x1b]0;C:\\Tools\\node.exe\x07",
    "\x1b]2;node test\x1b\\",
    "\x9d0;node test\x9c",
  ]) {
    assert.deepEqual(parseCheckCounts(title + tap, "tap"), {
      passed: 8,
      failed: 0,
    });
    assert.deepEqual(parseCheckCounts(title + marker, "memcode-json"), {
      passed: 19,
      failed: 0,
    });
  }
  for (const hidden of ["\x1b]0;" + tap + "\x07", "\x1b]0;" + tap])
    assert.deepEqual(parseCheckCounts(hidden, "tap"), {
      passed: null,
      failed: null,
    });

  const f = await fixture();
  try {
    const output =
      "\x1b[?9001h\x1b[m\x1b]0;C:\\Tools\\node.exe\x07\x1b[?25h" + tap;
    const result = await runTaskVerification(
      () => f.state,
      f.manager((request) => reply(request.after, output)),
      { ...f.input, format: "tap" },
    );
    assert.equal(result.linked, true);
    assert.equal(result.passed, 8);
    assert.equal(result.failed, 0);
  } finally {
    await f.close();
  }
});

test("manual edits before verification cannot be attributed to the earlier worker even when source stays stable during checks", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "src/main.mjs"), "export const value=2;\n");
    const result = await runTaskVerification(
      () => f.state,
      f.manager((request) => reply(request.after)),
      f.input,
    );
    assert.equal(result.passed, 19, "local checks still run");
    assert.equal(
      result.linked,
      false,
      "a cached run/revision string does not prove the finished source is unchanged",
    );
  } finally {
    await f.close();
  }
});

test("source edits during checks and missing historical finish bindings keep verification unlinked", async () => {
  const f = await fixture();
  try {
    const terminal = f.manager(async (request) => {
      await writeFile(join(f.root, "src/main.mjs"), "export const value=2;\n");
      return reply(request.after);
    });
    assert.equal(
      (await runTaskVerification(() => f.state, terminal, f.input)).linked,
      false,
    );
    f.task.run.finishedSourceBinding = null;
    const old = await runTaskVerification(
      () => f.state,
      f.manager((request) => reply(request.after)),
      f.input,
    );
    assert.equal(old.passed, 19);
    assert.equal(old.linked, false);
  } finally {
    await f.close();
  }
});

test("new runs, revisions and active state cannot inherit a completed check's attribution", async () => {
  for (const change of [
    (task: WorkItem) => {
      task.run.changeRunId = "next-run";
    },
    (task: WorkItem) => {
      task.changesRevision = "next-revision";
    },
    (task: WorkItem) => {
      task.run.state = "running";
    },
  ]) {
    const f = await fixture();
    try {
      const result = await runTaskVerification(
        () => f.state,
        f.manager((request) => {
          change(f.task);
          return reply(request.after);
        }),
        f.input,
      );
      assert.equal(result.linked, false);
      if (f.task.run.changeRunId === "next-run")
        assert.equal(
          f.task.run.checks,
          undefined,
          "an old check cannot overwrite a new run",
        );
    } finally {
      await f.close();
    }
  }
});

test("missing chunks, sequence gaps, malformed base64 and explicit truncation never establish counts", async () => {
  for (const output of [
    {
      session: { id: sessionId, status: "exited", seq: 1, exitCode: 0 },
      text: marker,
    },
    {
      session: { id: sessionId, status: "exited", seq: 2, exitCode: 0 },
      chunks: [chunk(2, marker)],
    },
    {
      session: { id: sessionId, status: "exited", seq: 1, exitCode: 0 },
      chunks: [{ seq: 1, data: "not valid base64" }],
    },
    { ...reply(0), truncated: true },
  ]) {
    const f = await fixture();
    try {
      const result = await runTaskVerification(
        () => f.state,
        f.manager(() => output),
        f.input,
      );
      assert.equal(result.passed, null);
      assert.equal(result.failed, null);
      assert.equal(result.linked, false);
    } finally {
      await f.close();
    }
  }
});

test("the runner's own output cap cannot silently hide an earlier conflicting report", async () => {
  const f = await fixture();
  try {
    const output = marker + "x".repeat(270000) + "\n" + marker;
    const result = await runTaskVerification(
      () => f.state,
      f.manager((request) => reply(request.after, output)),
      f.input,
    );
    assert.equal(result.passed, null);
    assert.equal(result.failed, null);
    assert.equal(result.linked, false);
  } finally {
    await f.close();
  }
});

test("a check timeout stops only its owned terminal and cannot report earlier partial success", async () => {
  const f = await fixture();
  try {
    const result = await runTaskVerification(
      () => f.state,
      f.manager((request) => ({
        ...reply(request.after),
        session: { id: sessionId, status: "running", seq: 1 },
      })),
      f.input,
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.passed, null);
    assert.equal(result.linked, false);
    assert.equal(f.stopped(), 1);
  } finally {
    await f.close();
  }
});

test("observation errors clean up the owned verifier process and propagate instead of leaving a terminal running", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runTaskVerification(
        () => f.state,
        f.manager(() => {
          throw Error("observing failed");
        }),
        f.input,
      ),
      /observing failed/,
    );
    assert.equal(f.stopped(), 1);
  } finally {
    await f.close();
  }
});

test("process-exit notifications drain trailing PTY chunks before parsing the final report", async () => {
  const f = await fixture();
  try {
    const result = await runTaskVerification(
      () => f.state,
      f.manager((request, iteration) =>
        iteration === 1
          ? {
              session: { id: sessionId, status: "exited", seq: 0, exitCode: 0 },
              chunks: [],
            }
          : reply(request.after),
      ),
      f.input,
    );
    assert.equal(result.passed, 19);
    assert.equal(result.linked, true);
    assert.ok(f.observed() >= 3);
  } finally {
    await f.close();
  }
});

test("an interrupted process or contradictory exit/report cannot be represented as passed assertions", async () => {
  for (const exitCode of [null, 130, 1]) {
    const f = await fixture();
    try {
      const result = await runTaskVerification(
        () => f.state,
        f.manager((request) => ({
          ...reply(request.after),
          session: { id: sessionId, status: "exited", seq: 1, exitCode },
        })),
        f.input,
      );
      assert.equal(result.passed, null);
      assert.equal(result.failed, null);
    } finally {
      await f.close();
    }
  }
});

test("source bindings frame filenames and bytes, retain leading whitespace and bound large files", async () => {
  const f = await fixture();
  try {
    await rm(join(f.root, "src"), { recursive: true });
    await writeFile(join(f.root, "a"), "bc");
    const before = await checkSourceBinding(f.root);
    await rename(join(f.root, "a"), join(f.root, "ab"));
    await writeFile(join(f.root, "ab"), "c");
    assert.notEqual(
      await checkSourceBinding(f.root),
      before,
      "different path/content framing must not collide",
    );
    await writeFile(join(f.root, "  leading.mjs"), "first");
    const whitespace = await checkSourceBinding(f.root);
    await writeFile(join(f.root, "  leading.mjs"), "second");
    assert.notEqual(await checkSourceBinding(f.root), whitespace);
    await writeFile(join(f.root, "\ufeffbom.mjs"), "first");
    const bom = await checkSourceBinding(f.root);
    await writeFile(join(f.root, "\ufeffbom.mjs"), "second");
    assert.notEqual(await checkSourceBinding(f.root), bom);
    await writeFile(
      join(f.root, "vendored-archive.tar.gz"),
      Buffer.alloc(3_000_000),
    );
    const archive = await checkSourceBinding(f.root);
    assert.ok(
      archive,
      "A normal vendored asset must not make all review measurements unavailable",
    );
    await writeFile(
      join(f.root, "vendored-archive.tar.gz"),
      Buffer.alloc(3_000_000, 1),
    );
    assert.notEqual(
      await checkSourceBinding(f.root),
      archive,
      "Binary changes remain part of the exact source fingerprint",
    );
    await writeFile(join(f.root, "too-large.mjs"), Buffer.alloc(8_000_001));
    assert.equal(await checkSourceBinding(f.root), null);
  } finally {
    await f.close();
  }
});

test("source bindings refuse paths resolved outside the project", async () => {
  const f = await fixture(),
    outside = await mkdtemp(join(tmpdir(), "memcode-checks-outside-"));
  try {
    await writeFile(join(outside, "outside.mjs"), "outside");
    await symlink(
      outside,
      join(f.root, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(await checkSourceBinding(f.root), null);
  } finally {
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});
