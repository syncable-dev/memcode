// Run only in an isolated candidate checkout on the user's own Mac.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
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
const git = (...a) =>
  execFileSync("git", ["-C", source, ...a], { encoding: "utf8" }).trim();
const sourceCommit = git("rev-parse", "HEAD");
assert.equal(sourceCommit, "6ec252fb65599d3a2aaae8df7daf5ae934c6a58a");
git(
  "diff",
  "--exit-code",
  "HEAD",
  "--",
  "crates",
  "Cargo.toml",
  "Cargo.lock",
  "vendor",
  "ui/src",
  "ui/package.json",
  "ui/package-lock.json",
);
const submodules = git("submodule", "status");
assert.ok(
  !submodules.split("\n").some((s) => /^[-+U]/.test(s)),
  "Initialize the exact recorded submodules first.",
);
execFileSync("/usr/bin/xcrun", ["--find", "clang"], { stdio: "pipe" });
await mkdir(output, { recursive: true, mode: 0o700 });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !/^CARGO_PROFILE_RELEASE_|^RUSTFLAGS$|^CARGO_ENCODED_RUSTFLAGS$|^RUST_MIN_STACK$/.test(
        k,
      ),
  ),
);
Object.assign(env, {
  RUSTUP_TOOLCHAIN: "1.97.1-aarch64-apple-darwin",
  CARGO_TARGET_DIR: join(source, "target"),
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "2",
  MACOSX_DEPLOYMENT_TARGET: "13.5",
  MEMTRACE_REQUIRE_NOTIFICATION_HELPER: "1",
  RUSTFLAGS: `--remap-path-prefix=${source}=/src`,
});
assert.match(
  execFileSync("rustc", ["-Vv"], { encoding: "utf8", env }),
  /^release: 1\.97\.1$/m,
  "Use the pinned Rust compiler.",
);
const log = [];
const run = async (command, args, cwd) => {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", reject);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (part) => {
        log.push(part);
        process.stdout.write(part);
      });
    child.on("close", resolve);
  });
  await writeFile(join(output, "local-build.log"), Buffer.concat(log), {
    mode: 0o600,
  });
  assert.equal(code, 0, command + " failed");
};
await run("npm", ["ci"], join(source, "ui"));
await run("npm", ["run", "build"], join(source, "ui"));
const command = [
  "build",
  "--locked",
  "--release",
  "--target",
  "aarch64-apple-darwin",
  "-p",
  "memtrace-mcp",
  "--bin",
  "memtrace",
  "--config",
  "profile.release.opt-level=3",
  "--config",
  "profile.release.lto=true",
  "--config",
  "profile.release.codegen-units=1",
  "--config",
  'profile.release.panic="unwind"',
];
const started = Date.now();
await run("cargo", command, source);
const binary = join(source, "target/aarch64-apple-darwin/release/memtrace");
const hash = createHash("sha256");
let bytes = 0;
for await (const part of createReadStream(binary)) {
  hash.update(part);
  bytes += part.length;
}
assert.equal(
  execFileSync(binary, ["--version"], { encoding: "utf8", env }).trim(),
  "memtrace 1.2.21",
);
const receipt = {
  schemaVersion: 1,
  kind: "memcode-local-native-build",
  buildOrigin: "local",
  sourceCommit,
  sourceDiff: git("diff", "--stat"),
  submodules,
  platform: process.platform,
  arch: process.arch,
  target: "aarch64-apple-darwin",
  rustc: execFileSync("rustc", ["-Vv"], { encoding: "utf8", env }),
  cargo: execFileSync("cargo", ["-V"], { encoding: "utf8", env }).trim(),
  command: ["cargo", ...command],
  profile: { optLevel: 3, lto: true, codegenUnits: 1, panic: "unwind" },
  minimumMacOS: "13.5",
  diagnosticThreadStackBytes: null,
  binary,
  engineBytes: bytes,
  engineSha256: hash.digest("hex"),
  buildSeconds: Math.round((Date.now() - started) / 1000),
  hostedVerification: false,
  published: false,
};
await writeFile(
  join(output, "local-build.json"),
  JSON.stringify(receipt, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({
    passed: true,
    binary,
    engineSha256: receipt.engineSha256,
    receipt: join(output, "local-build.json"),
  }),
);
