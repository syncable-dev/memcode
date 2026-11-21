import test from "node:test";
import assert from "node:assert/strict";
import { childEnv } from "../runtime/commands";

test("standalone workers keep their configuration without claiming the desktop parent's Core identity", () => {
  const keys = [
    "CODEX_WINDOWS_REGISTERED_CORE",
    "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY",
  ] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "parent-process-only";
    const child = childEnv();
    for (const key of keys) {
      assert.equal(child[key], undefined);
      assert.equal(process.env[key], "parent-process-only");
    }
    assert.equal(child.USERPROFILE, process.env.USERPROFILE);
    assert.equal(child.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(
      child.CODEX_PERMISSION_PROFILE,
      process.env.CODEX_PERMISSION_PROFILE,
    );
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
  }
});

test("the engine MemCode starts lets workers who agree settle a disagreement without the person", () => {
  const before = process.env.MEMTRACE_FLEET_MEDIATOR;
  try {
    delete process.env.MEMTRACE_FLEET_MEDIATOR;
    assert.equal(childEnv({ engine: true }).MEMTRACE_FLEET_MEDIATOR, "auto");
    assert.equal(childEnv().MEMTRACE_FLEET_MEDIATOR, undefined, "workers and tools are not given engine settings");
    process.env.MEMTRACE_FLEET_MEDIATOR = "advisory";
    assert.equal(childEnv({ engine: true }).MEMTRACE_FLEET_MEDIATOR, "advisory", "a person's own choice is kept");
  } finally {
    if (before === undefined) delete process.env.MEMTRACE_FLEET_MEDIATOR;
    else process.env.MEMTRACE_FLEET_MEDIATOR = before;
  }
});
