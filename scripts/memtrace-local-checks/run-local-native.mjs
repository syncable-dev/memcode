// Developer acceptance only. Reads only the current short app access proof;
// never reads Keychain/refresh/CLI credentials, modifies profiles or publishes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expectedEngineCommit } from "./source-selection.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2),
  option = (name) => {
    const at = args.indexOf(name);
    assert.ok(at >= 0 && args[at + 1], "Missing " + name);
    return args[at + 1];
  };
assert.equal(
  process.platform,
  "darwin",
  "Run this entry point on the local Mac being validated.",
);
assert.equal(
  process.arch,
  "arm64",
  "The reviewed Mac sidecar pin targets Apple silicon.",
);
const app = resolve(option("--app")),
  source = resolve(option("--engine-source")),
  binary = resolve(option("--engine")),
  buildReceiptPath = resolve(option("--build-receipt"));
const mode = args.includes("--mode") ? option("--mode") : "all";
assert.ok(
  ["all", "owned", "product", "direct", "legacy", "review"].includes(mode),
);
const sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(
  sourceCommit,
  expectedEngineCommit(args),
  "Use the exact candidate engine source.",
);
execFileSync(
  "git",
  [
    "-C",
    source,
    "diff",
    "--exit-code",
    "HEAD",
    "--",
    "crates",
    "Cargo.toml",
    "Cargo.lock",
    "vendor",
  ],
  { stdio: "pipe" },
);
const root = await realpath(
  await mkdtemp(join(tmpdir(), "memcode-native-local-")),
);
await chmod(root, 0o700);
await mkdir(join(root, "home"), { mode: 0o700 });
const profile = join(
  args.includes("--app-data")
    ? resolve(option("--app-data"))
    : join(homedir(), "Library/Application Support/MemCode"),
  "webview",
);
const namespace = createHash("sha256").update(profile).digest("hex");
const accessFile = args.includes("--access-file")
  ? resolve(option("--access-file"))
  : join(
      homedir(),
      "Library/Application Support/com.memtrace.memcode/beta",
      namespace,
      "access.jwt",
    );
const proof = join(root, "approved-short-proof.json");
let accessProof;
try {
  const info = await lstat(accessFile);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 16384);
  assert.equal(info.mode & 0o077, 0);
  accessProof = (await readFile(accessFile, "utf8")).trim();
} catch {
  throw Error(
    "No current MemCode short access proof is available. Open the already-connected MemCode app, refresh its Memtrace account, then rerun. Do not reconnect, read Keychain or export refresh credentials.",
  );
}
const parts = accessProof.split(".");
assert.equal(parts.length, 3);
const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
assert.ok(
  Number.isInteger(claims.exp) && claims.exp * 1000 > Date.now() + 240000,
  "The app short proof is near expiry. Refresh the existing app account and rerun; no new approval is needed.",
);
const descriptor = {
  kind: "short-lived-engine-proof",
  deviceId: claims.device_id,
  sessionId: claims.session_id,
  accessProof,
};
await writeFile(proof, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
try {
  const require = createRequire(join(app, "package.json")),
    { build } = require("esbuild");
  const catalog = JSON.parse(
      await readFile(join(app, "scripts/memtrace-engine.json"), "utf8"),
    ),
    pin = catalog.bundles["macos-aarch64"];
  assert.equal(
    pin.id,
    "1af4f475a-beta.1",
    "Review new sidecar provenance before changing this fixture.",
  );
  const url = new URL(pin.url);
  assert.equal(url.protocol, "https:");
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  assert.ok(/^d[a-z0-9]{10,}\.cloudfront\.net$/.test(url.hostname));
  assert.ok(url.pathname.startsWith("/releases/memtrace-engine/1af4f475a/"));
  const digest = async (path) => {
    const hash = createHash("sha256");
    for await (const part of createReadStream(path)) hash.update(part);
    return hash.digest("hex");
  };
  const buildReceipt = JSON.parse(await readFile(buildReceiptPath, "utf8"));
  assert.equal(buildReceipt.kind, "memcode-local-native-build");
  assert.equal(buildReceipt.sourceCommit, sourceCommit);
  assert.equal(buildReceipt.buildOrigin, "local");
  assert.equal(buildReceipt.engineSha256, await digest(binary));
  assert.equal(buildReceipt.target, "aarch64-apple-darwin");
  assert.equal(buildReceipt.diagnosticThreadStackBytes, null);
  assert.deepEqual(buildReceipt.profile, {
    optLevel: 3,
    lto: true,
    codegenUnits: 1,
    panic: "unwind",
  });
  const cache = join(app, ".memcode/engine-archive-cache", pin.sha256 + ".zip");
  let archive = cache;
  try {
    const info = await lstat(cache);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.size, pin.bytes);
    assert.equal(await digest(cache), pin.sha256);
  } catch {
    archive = join(root, "reviewed-sidecars.zip");
    const response = await fetch(pin.url, {
      redirect: "error",
      signal: AbortSignal.timeout(180000),
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const { open } = await import("node:fs/promises"),
      file = await open(archive, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const part of response.body) {
        bytes += part.byteLength;
        assert.ok(bytes <= pin.bytes);
        hash.update(part);
        await file.write(part);
      }
    } finally {
      await file.close();
    }
    assert.equal(bytes, pin.bytes);
    assert.equal(hash.digest("hex"), pin.sha256);
  }
  const candidate = join(root, "candidate");
  await mkdir(candidate, { mode: 0o700 });
  const inventory = execFileSync("/usr/bin/unzip", ["-Z1", archive], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  assert.equal(new Set(inventory).size, inventory.length);
  assert.deepEqual(inventory.sort(), pin.files.map((f) => f.name).sort());
  assert.ok(
    pin.files.every((f) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(f.name)),
    "Only flat reviewed paths may be extracted.",
  );
  execFileSync("/usr/bin/unzip", ["-q", archive, "-d", candidate], {
    stdio: "pipe",
  });
  for (const file of pin.files) {
    const path = join(candidate, file.name),
      info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.size, file.bytes);
    assert.equal(await digest(path), file.sha256);
  }
  await copyFile(binary, join(candidate, "memtrace"));
  for (const name of [
    "memtrace",
    "memcore-server",
    "memcortex-daemon",
    "memcortex-mcp",
  ])
    await chmod(join(candidate, name), 0o755);
  assert.match(
    execFileSync("/usr/bin/file", [join(candidate, "memtrace")], {
      encoding: "utf8",
    }),
    /Mach-O 64-bit executable arm64/,
  );
  assert.equal(
    execFileSync(join(candidate, "memtrace"), ["--version"], {
      encoding: "utf8",
      timeout: 15000,
    }).trim(),
    "memtrace 1.2.21",
  );
  const componentProvenance = {
    schemaVersion: 1,
    buildOrigin: "local",
    sourceCommit,
    memcodeCommit: execFileSync("git", ["-C", app, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    candidateMainSha256: await digest(join(candidate, "memtrace")),
    sidecarBundle: pin.id,
    sidecarArchiveSha256: pin.sha256,
    sidecars: pin.files.filter((f) => f.name !== "memtrace"),
    notPublished: true,
  };
  await writeFile(
    join(root, "component-provenance.json"),
    JSON.stringify(componentProvenance, null, 2) + "\n",
  );
  for (const [entry, output] of [
    ["owned-worktree-native-acceptance.mts", "test.cjs"],
    ["code-review-native-acceptance.mts", "review-test.cjs"],
  ]) {
    const sourceText = (
      await readFile(join(directory, entry), "utf8")
    ).replaceAll("../memcode/", app + "/");
    await build({
      stdin: {
        contents: sourceText,
        loader: "ts",
        sourcefile: entry,
        resolveDir: app,
      },
      outfile: join(root, output),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      logLevel: "silent",
    });
  }
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:MEMCODE_|MEMTRACE_|MEMDB_|MEMCORTEX_|CORTEX_|NODE_|APPLE_|ANTHROPIC_|OPENAI_|CLAUDE_|CURSOR_|TAURI_SIGNING_|CODEX_|GIT_|AWS_|AZURE_|GOOGLE_)/i.test(
          key,
        ) && !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(key),
    ),
  );
  delete baseEnv.RUST_MIN_STACK;
  Object.assign(baseEnv, {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home/.config"),
    XDG_CACHE_HOME: join(root, "home/.cache"),
    MEMTRACE_MEMDB_SIDECAR_STARTUP_SECS: "180",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    OWNED_NATIVE_RELEASE: "1",
  });
  // Preserve executable lookup only; all source, data and credentials are fixture-local.
  baseEnv.PATH = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const receipts = [];
  for (const selected of mode === "all"
    ? ["owned", "product", "direct", "legacy", "review"]
    : [mode]) {
    const fixture = join(root, selected);
    await mkdir(fixture, { mode: 0o700 });
    const env = {
      ...baseEnv,
      OWNED_NATIVE_ONLY: selected === "owned" ? "1" : "0",
      OWNED_NATIVE_PRODUCT: selected === "product" ? "1" : "0",
      OWNED_NATIVE_DIRECT_ONLY: selected === "direct" ? "1" : "0",
      OWNED_NATIVE_LEGACY_ONLY: selected === "legacy" ? "1" : "0",
      OWNED_NATIVE_EXPECTED_ENGINE_SHA: componentProvenance.candidateMainSha256,
      MEMCODE_EXPECT_SOURCE_QUALITY: args.includes("--require-source-quality")
        ? "1"
        : "0",
    };
    assert.equal(env.RUST_MIN_STACK, undefined);
    console.log(
      JSON.stringify({
        stage: "start-local-" + selected,
        root: fixture,
        sourceCommit,
        engineSha256: componentProvenance.candidateMainSha256,
      }),
    );
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(root, selected === "review" ? "review-test.cjs" : "test.cjs"),
          fixture,
          candidate,
          source,
          proof,
          app,
        ],
        { cwd: fixture, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.on("data", (chunk) => process.stdout.write(chunk));
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("close", resolve);
    });
    const report = JSON.parse(
      await readFile(join(fixture, "result.json"), "utf8"),
    );
    receipts.push({
      mode: selected,
      passed: report.passed,
      exitCode: code,
      evidence: join(fixture, "result.json"),
    });
    await writeFile(
      join(root, "local-validation.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          platform: process.platform,
          arch: process.arch,
          buildOrigin: "local",
          sourceCommit,
          diagnosticThreadStackBytes: null,
          normalProfilesTouched: false,
          componentProvenance,
          receipts,
          passed: receipts.every((r) => r.passed && r.exitCode === 0),
        },
        null,
        2,
      ) + "\n",
    );
    assert.equal(code, 0);
    assert.equal(report.passed, true, report.failure ?? selected + " failed");
  }
  console.log(
    JSON.stringify({
      passed: true,
      report: join(root, "local-validation.json"),
      sourceCommit,
      engineSha256: componentProvenance.candidateMainSha256,
    }),
  );
} finally {
  await rm(proof, { force: true });
}
