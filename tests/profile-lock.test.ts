import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { holdProfile } from "../runtime/profile-lock";

const using = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-lock-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const lock = (dir: string) => join(dir, "runtime.lock");
/** Another process, which is there for this long. */
const other = (ms: number) =>
  spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: "ignore" });

test("a profile is written by one MemCode and let go of when it closes", () =>
  using(async (dir) => {
    const letGo = await holdProfile(dir);
    assert.equal(JSON.parse(await readFile(lock(dir), "utf8")).pid, process.pid);
    await assert.rejects(holdProfile(dir, { wait: 300 }), /already open/);
    await letGo();
    await (await holdProfile(dir, { wait: 0 }))();
  }));

test("a MemCode that is still closing is waited for", () =>
  using(async (dir) => {
    const closing = other(1_200);
    await writeFile(lock(dir), JSON.stringify({ owner: "memcode-runtime", pid: closing.pid }));
    const started = Date.now();
    const letGo = await holdProfile(dir, { wait: 10_000 });
    assert.ok(Date.now() - started > 500, "it waited");
    assert.equal(JSON.parse(await readFile(lock(dir), "utf8")).pid, process.pid);
    await letGo();
  }));

test("a MemCode that closes and lets go itself is waited for too", () =>
  using(async (dir) => {
    const letGo = await holdProfile(dir);
    setTimeout(() => void letGo(), 500);
    await (await holdProfile(dir, { wait: 10_000 }))();
  }));

test("what a crash left behind is taken over at once", () =>
  using(async (dir) => {
    const crashed = other(0);
    await new Promise((done) => crashed.once("exit", done));
    await writeFile(lock(dir), JSON.stringify({ owner: "memcode-runtime", pid: crashed.pid }));
    const started = Date.now();
    await (await holdProfile(dir))();
    assert.ok(Date.now() - started < 2_000);
  }));

test("a lock nobody can read keeps the workspace as it is", () =>
  using(async (dir) => {
    await writeFile(lock(dir), "half a lo");
    await assert.rejects(holdProfile(dir, { wait: 300 }), /unreadable runtime lock/);
    assert.equal(await readFile(lock(dir), "utf8"), "half a lo");
  }));
