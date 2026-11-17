// Local receipts: no Actions invocation and no fabricated workflow identity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const args = process.argv.slice(2),
  option = (name) => {
    const i = args.indexOf(name);
    assert.ok(i >= 0 && args[i + 1], "Missing " + name);
    return args[i + 1];
  };
const source = resolve(option("--engine-source")),
  output = resolve(option("--output"));
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(sourceCommit, "6ec252fb65599d3a2aaae8df7daf5ae934c6a58a");
const { parseUnitGate, fastTestProfile } = await import(
  pathToFileURL(join(source, "scripts/run-memcode-engine-unit-gates.mjs")).href
);
await mkdir(output, { recursive: true, mode: 0o700 });
const env = { ...process.env, ...fastTestProfile, CARGO_BUILD_JOBS: "2" };
delete env.RUST_MIN_STACK;
const target = "aarch64-apple-darwin",
  receipts = [];
for (const [name, filter] of [
  ["owned", "owned_checkout::tests::"],
  ["beta", "memcode_beta::tests::"],
  ["runtime", "memcode_runtime"],
  [
    "overlay",
    "watcher::tests::linked_worktree_watch_refreshes_private_edits_without_mutating_canonical_symbols",
  ],
]) {
  const command = [
      "test",
      "--target",
      target,
      "-p",
      "memtrace-mcp",
      "--bin",
      "memtrace",
      filter,
      "--",
      "--nocapture",
    ],
    chunks = [];
  let bytes = 0;
  console.log(
    JSON.stringify({ stage: "local-unit-" + name, sourceCommit, target }),
  );
  const code = await new Promise((resolve, reject) => {
    const child = spawn("cargo", command, {
      cwd: source,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", reject);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (part) => {
        bytes += part.length;
        if (bytes > 32_000_000) {
          child.kill();
          reject(Error("Bounded unit log exceeded"));
          return;
        }
        chunks.push(part);
        process.stdout.write(part);
      });
    child.on("close", resolve);
  });
  const log = Buffer.concat(chunks);
  await writeFile(join(output, name + ".log"), log, {
    flag: "wx",
    mode: 0o600,
  });
  assert.equal(code, 0, "Native unit group failed: " + name);
  const receipt = {
    schemaVersion: 1,
    buildOrigin: "local",
    sourceCommit,
    target,
    profile: fastTestProfile,
    diagnosticThreadStackBytes: null,
    command: ["cargo", ...command],
    ...parseUnitGate(log, filter, target),
    logSha256: createHash("sha256").update(log).digest("hex"),
  };
  receipts.push(receipt);
  await writeFile(
    join(output, name + ".json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
await writeFile(
  join(output, "summary.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      buildOrigin: "local",
      sourceCommit,
      passed: true,
      receipts,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({ passed: true, report: join(output, "summary.json") }),
);
