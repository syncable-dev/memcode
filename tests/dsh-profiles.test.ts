import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDshAcpProfile,
  defaultDshProfile,
  inspectDshProfiles,
  isTemporaryDryRunProfile,
  normalizeDshProfile,
  resolveDshHome,
} from "../runtime/dsh-profiles";

async function makeTempDshHome(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memcode-dsh-profiles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "profiles"), { recursive: true });
  return dir;
}

test("resolveDshHome, normalizeDshProfile, and isTemporaryDryRunProfile validate inputs", () => {
  assert.equal(defaultDshProfile, "acp");
  assert.equal(resolveDshHome({}), join(homedir(), ".dsh"));
  assert.equal(resolveDshHome({ DSH_HOME: "  D:\\synthetic\\.dsh  " }), "D:\\synthetic\\.dsh");

  assert.equal(normalizeDshProfile(undefined), "acp");
  assert.equal(normalizeDshProfile("   "), "acp");
  assert.equal(normalizeDshProfile(" custom-acp "), "custom-acp");
  assert.equal(normalizeDshProfile("work_1.acp-dev"), "work_1.acp-dev");

  assert.throws(() => normalizeDshProfile("desktop"), /desktop/i);
  assert.throws(() => normalizeDshProfile("DeSkToP"), /desktop/i);
  assert.throws(() => normalizeDshProfile("node_modules"), /node_modules/i);
  assert.throws(() => normalizeDshProfile("memcode-dryrun-deadbeef"), /reserved/i);
  assert.throws(() => normalizeDshProfile("../bad"), /Invalid DeepSeek Harness profile/);
  assert.throws(() => normalizeDshProfile("-leading-dash"), /Invalid DeepSeek Harness profile/);
  assert.throws(() => normalizeDshProfile("a".repeat(65)), /Invalid DeepSeek Harness profile/);

  assert.equal(isTemporaryDryRunProfile("memcode-dryrun-deadbeef"), true);
  assert.equal(isTemporaryDryRunProfile("MEMCODE-DRYRUN-0123ABCD"), true);
  assert.equal(isTemporaryDryRunProfile("custom-acp"), false);
  assert.equal(isTemporaryDryRunProfile("acp"), false);
});

test("inspectDshProfiles classifies arbitrary ACP vs non-ACP profiles and skips special directories", async (t) => {
  const dshHome = await makeTempDshHome(t);
  const profilesDir = join(dshHome, "profiles");
  const env = { DSH_HOME: dshHome };

  await mkdir(join(profilesDir, "desktop"), { recursive: true });
  await mkdir(join(profilesDir, "node_modules"), { recursive: true });
  await mkdir(join(profilesDir, ".hidden"), { recursive: true });
  await mkdir(join(profilesDir, "memcode-dryrun-1234abcd"), { recursive: true });

  // Uncustomized default "acp"
  await mkdir(join(profilesDir, "acp"), { recursive: true });
  await writeFile(
    join(profilesDir, "acp", "package.json"),
    JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] } } }),
  );
  await writeFile(join(profilesDir, "acp", "cordis.patch.yml"), "# `!!js` allowed in comments\n[]\n");

  // Custom configured ACP profile named "custom-acp"
  await mkdir(join(profilesDir, "custom-acp"), { recursive: true });
  await writeFile(
    join(profilesDir, "custom-acp", "package.json"),
    JSON.stringify({
      dependencies: { "dsh-sample-provider": "0.4.6" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] } },
    }),
  );

  // ACP detected via cordis.patch.yml insert
  await mkdir(join(profilesDir, "patch-acp"), { recursive: true });
  await writeFile(
    join(profilesDir, "patch-acp", "cordis.patch.yml"),
    "- insert:\n    - name: '@deepseek-ai/dsh-acp'\n",
  );

  // Conflicting non-ACP profile
  await mkdir(join(profilesDir, "web"), { recursive: true });
  await writeFile(
    join(profilesDir, "web", "package.json"),
    JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-acp-app", "@deepseek-ai/dsh-web-app"] } } }),
  );

  const auto = await inspectDshProfiles(undefined, env);
  assert.equal(auto.desktopProfilePresent, true);
  assert.equal(auto.needsProfileCreation, false);
  assert.equal(auto.activeProfile, "custom-acp");
  assert.equal(auto.recommendedProfile, "custom-acp");
  assert.deepEqual(
    auto.acpProfiles.map((p) => [p.name, p.hasCustomConfig]),
    [
      ["acp", false],
      ["custom-acp", true],
      ["patch-acp", true],
    ],
  );
  assert.deepEqual(
    auto.nonAcpProfiles.map((p) => p.name),
    ["web"],
  );

  const nonAcpConfigured = await inspectDshProfiles("web", env);
  assert.equal(nonAcpConfigured.activeProfile, "web");
  assert.equal(nonAcpConfigured.activeProfileIssue, "non-acp");

  const missingConfigured = await inspectDshProfiles("does-not-exist", env);
  assert.equal(missingConfigured.activeProfile, "does-not-exist");
  assert.equal(missingConfigured.activeProfileIssue, "missing");
});

test("inspectDshProfiles requests profile creation when no ACP profiles exist", async (t) => {
  const dshHome = await makeTempDshHome(t);
  const inspected = await inspectDshProfiles(undefined, { DSH_HOME: dshHome });
  assert.equal(inspected.needsProfileCreation, true);
  assert.equal(inspected.activeProfile, "acp");
  assert.equal(inspected.activeProfileIssue, undefined);
  assert.equal(inspected.desktopProfilePresent, false);
});

test("inspectDshProfiles flags a non-ACP default directory and never selects unusable names", async (t) => {
  const dshHome = await makeTempDshHome(t);
  const profilesDir = join(dshHome, "profiles");
  const env = { DSH_HOME: dshHome };
  const acpBundles = JSON.stringify({
    dependencies: { "dsh-sample-provider": "0.4.6" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-acp-app"] } },
  });
  // Customized ACP profiles whose names dsh cannot be given.
  for (const name of ["acp copy", "_backup"]) {
    await mkdir(join(profilesDir, name), { recursive: true });
    await writeFile(join(profilesDir, name, "package.json"), acpBundles);
  }
  // An existing "acp" directory that is a web profile, not ACP.
  await mkdir(join(profilesDir, "acp"), { recursive: true });
  await writeFile(
    join(profilesDir, "acp", "package.json"),
    JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } } }),
  );

  const inspected = await inspectDshProfiles(undefined, env);
  assert.deepEqual(inspected.acpProfiles, []);
  assert.deepEqual(inspected.nonAcpProfiles.map((p) => p.name), ["acp"]);
  assert.equal(inspected.activeProfile, "acp");
  assert.equal(inspected.activeProfileIssue, "non-acp");
  assert.equal(inspected.needsProfileCreation, true);
});

test("createDshAcpProfile uses correct CLI flags for shipped acp vs custom profile names", async (t) => {
  const dshHome = await makeTempDshHome(t);
  const scriptPath = join(dshHome, "mock-dsh.mjs");
  const argsLog = join(dshHome, "calls.jsonl");
  await writeFile(
    scriptPath,
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(argv) + "\\n");
const idx = argv.indexOf("--profile");
const name = argv[idx + 1];
const dir = join(process.env.DSH_HOME, "profiles", name);
mkdirSync(dir, { recursive: true });
const bundle = name === "broken" ? "@deepseek-ai/dsh-web-app" : "@deepseek-ai/dsh-acp-app";
writeFileSync(join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [bundle] } } }));
`,
  );

  const command = { command: process.execPath, prefix: [scriptPath] };
  const env = { DSH_HOME: dshHome };

  assert.equal(await createDshAcpProfile(command, "acp", env), "acp");
  assert.equal(await createDshAcpProfile(command, "work", env), "work");
  await assert.rejects(() => createDshAcpProfile(command, "work", env), /already exists/i);
  await assert.rejects(() => createDshAcpProfile(command, "broken", env), /valid DeepSeek Harness ACP profile/i);

  const { readFileSync } = await import("node:fs");
  const calls = readFileSync(argsLog, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as string[]);

  assert.deepEqual(calls[0], ["--profile", "acp", "--dump-config"]);
  assert.deepEqual(calls[1], ["--profile", "work", "--from-default-profile", "acp", "--dump-config"]);
});
