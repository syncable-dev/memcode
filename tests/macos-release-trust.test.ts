import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  macReleasePolicy,
  assertPublicMacTrust,
} from "../scripts/macos-release-trust.mjs";

const configured = () => ({
  APPLE_CERTIFICATE: "test-certificate-placeholder",
  APPLE_CERTIFICATE_PASSWORD: "test-password-placeholder",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (ABCDEFGHIJ)",
  APPLE_TEAM_ID: "ABCDEFGHIJ",
  APPLE_ID: "test@example.invalid",
  APPLE_PASSWORD: "app-specific-test-placeholder",
});

test("macOS public packaging fails closed instead of silently producing ad-hoc downloads", () => {
  assert.throws(() => macReleasePolicy({}), /APPLE_CERTIFICATE/);
  assert.throws(
    () => macReleasePolicy({ MEMCODE_MACOS_RELEASE_MODE: "unknown" }),
    /Choose/,
  );
  assert.equal(
    macReleasePolicy({ MEMCODE_MACOS_RELEASE_MODE: "private-candidate" })
      .publicReady,
    false,
  );
  const beta = macReleasePolicy({
    MEMCODE_MACOS_RELEASE_MODE: "manual-approval-beta",
  });
  assert.equal(beta.publicReady, false);
  assert.equal(beta.manualApprovalRequired, true);
  assert.equal(beta.betaDistributionAllowed, true);
  assert.equal(macReleasePolicy(configured()).mode, "public-release");
  assert.equal(macReleasePolicy(configured()).publicReady, false);
});

test("public packaging rejects ad-hoc identity, wrong team and incomplete notarization credentials", () => {
  assert.throws(
    () => macReleasePolicy({ ...configured(), APPLE_SIGNING_IDENTITY: "-" }),
    /Developer ID/,
  );
  assert.throws(
    () => macReleasePolicy({ ...configured(), APPLE_TEAM_ID: "ZZZZZZZZZZ" }),
    /must match/,
  );
  assert.throws(
    () => macReleasePolicy({ ...configured(), APPLE_PASSWORD: "" }),
    /complete notarization/,
  );
  assert.throws(
    () => macReleasePolicy({ ...configured(), APPLE_API_KEY: "partial" }),
    /incomplete/,
  );
  assert.throws(
    () =>
      macReleasePolicy({
        ...configured(),
        TAURI_SKIP_SIDECAR_SIGNATURE_CHECK: "true",
      }),
    /cannot skip/,
  );
});

test("complete API key configuration is accepted without an Apple ID password", () => {
  const env = {
    ...configured(),
    APPLE_ID: "",
    APPLE_PASSWORD: "",
    APPLE_API_KEY: "KEYID",
    APPLE_API_ISSUER: "issuer",
    APPLE_API_KEY_P8: "test-key-placeholder",
  };
  assert.equal(macReleasePolicy(env).authentication, "api-key");
});

test("an updater signature alone cannot qualify a Mac candidate as trusted", () => {
  assert.throws(
    () =>
      assertPublicMacTrust({
        updaterSignatureVerified: true,
        mode: "private-candidate",
      }),
    /not approved/,
  );
  assert.throws(
    () =>
      assertPublicMacTrust({
        updaterSignatureVerified: true,
        mode: "manual-approval-beta",
        manualApprovalRequired: true,
        betaDistributionAllowed: true,
      }),
    /not approved/,
  );
  const complete = {
    mode: "public-release",
    publicReady: true,
    developerIdSigned: true,
    notarized: true,
    appGatekeeper: "accepted",
    dmgGatekeeper: "accepted",
    appTicket: "validated",
    dmgTicket: "validated",
    updaterAppTicket: "validated",
    updaterAppGatekeeper: "accepted",
    signedNodeJitSmoke: "passed",
    dmgLayoutVerified: true,
    teamId: "ABCDEFGHIJ",
    nestedMachOCount: 2,
    bundledEngineNativeTrust: { developerIdSigned: true, gatekeeper: "accepted", nativeExecutables: 4 },
  };
  assert.equal(assertPublicMacTrust(complete), complete);
  for (const key of [
    "developerIdSigned",
    "notarized",
    "appTicket",
    "dmgTicket",
    "updaterAppTicket",
    "updaterAppGatekeeper",
    "appGatekeeper",
    "dmgGatekeeper",
    "dmgLayoutVerified",
    "signedNodeJitSmoke",
    "bundledEngineNativeTrust",
  ]) {
    assert.throws(
      () => assertPublicMacTrust({ ...complete, [key]: undefined }),
      /not approved/,
    );
  }
  assert.throws(() => assertPublicMacTrust({ ...complete, bundledEngineNativeTrust: { developerIdSigned: false, gatekeeper: "accepted", nativeExecutables: 4 } }), /not approved/);
  assert.throws(() => assertPublicMacTrust({ ...complete, bundledEngineNativeTrust: { developerIdSigned: true, gatekeeper: "not-established", nativeExecutables: 4 } }), /not approved/);
});

test("the installer background is genuinely 2x at the configured logical size", async () => {
  const png = await readFile(
    new URL("../src-tauri/dmg-background.png", import.meta.url),
  );
  assert.equal(png.readUInt32BE(16), 1440);
  assert.equal(png.readUInt32BE(20), 960);
  let physical: { x: number; y: number; unit: number } | undefined;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset),
      type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "pHYs")
      physical = {
        x: png.readUInt32BE(offset + 8),
        y: png.readUInt32BE(offset + 12),
        unit: png[offset + 16],
      };
    offset += length + 12;
  }
  assert.deepEqual(physical, { x: 5669, y: 5669, unit: 1 });
  const config = JSON.parse(
    await readFile(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(config.bundle.macOS.dmg.windowSize, {
    width: 720,
    height: 508,
  });
});

test("public packaging signs the native libraries bundled beside the app, which Apple otherwise rejects", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { bundledLibrariesToSign } = await import("../scripts/macos-release-trust.mjs");
  const root = await mkdtemp(join(tmpdir(), "memcode-mac-resources-"));
  const macho = Buffer.from("cffaedfe0000000000000000", "hex");
  const place = async (path: string, bytes: Buffer | string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  };
  try {
    const onnx = "dist-retriever-runtime/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64";
    await place(`${onnx}/onnxruntime_binding.node`, macho);
    await place(`${onnx}/libonnxruntime.1.23.2.dylib`, macho);
    await place("dist-retriever-runtime/node_modules/onnxruntime-node/README.md", "# docs");
    // Node is signed on its own, with the JIT entitlement it needs.
    await place("dist-desktop-runtime/node", macho);
    await place("src-tauri/target/release/memcode", macho);
    assert.deepEqual(
      (await bundledLibrariesToSign(root))
        .map((path: string) => path.slice(root.length + 1).replaceAll("\\", "/"))
        .sort(),
      [`${onnx}/libonnxruntime.1.23.2.dylib`, `${onnx}/onnxruntime_binding.node`],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a signed library's new fingerprint is recorded, so the app's own check still accepts it", async () => {
  const { mkdtemp, mkdir, writeFile, readFile: read, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { recordSignedFiles } = await import("../scripts/macos-release-trust.mjs");
  const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const root = await mkdtemp(join(tmpdir(), "memcode-mac-provenance-"));
  const folder = join(root, "dist-retriever-runtime");
  const library = "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node";
  try {
    await mkdir(join(folder, library, ".."), { recursive: true });
    await writeFile(join(folder, library), "signed bytes, longer than before");
    await writeFile(
      join(folder, "provenance.json"),
      JSON.stringify({
        schema: 1,
        files: [
          { name: library, bytes: 8, sha256: sha("unsigned") },
          { name: "package.json", bytes: 2, sha256: sha("{}") },
        ],
      }),
    );
    await recordSignedFiles(root, [join(folder, library)]);
    const { files } = JSON.parse(await read(join(folder, "provenance.json"), "utf8"));
    assert.deepEqual(files[0], {
      name: library,
      bytes: "signed bytes, longer than before".length,
      sha256: sha("signed bytes, longer than before"),
      unsignedSha256: sha("unsigned"),
    });
    assert.deepEqual(files[1], { name: "package.json", bytes: 2, sha256: sha("{}") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a command-line program counts as notarized only when Apple notarized it", { skip: process.platform !== "darwin" }, async () => {
  const { mkdtemp, copyFile, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { isNotarizedExecutable } = await import("../scripts/macos-release-trust.mjs");
  const folder = await mkdtemp(join(tmpdir(), "memcode-notarized-"));
  try {
    const local = join(folder, "echo");
    await copyFile("/bin/echo", local);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", local], { stdio: "ignore" });
    assert.equal(isNotarizedExecutable(local), false);
    // The engine packaging staged, Developer ID signed and notarized, when this computer has one.
    const engine = new URL("../dist-memtrace-engine/engine.zip", import.meta.url).pathname;
    if (existsSync(engine)) {
      execFileSync("/usr/bin/ditto", ["-x", "-k", engine, folder]);
      assert.equal(isNotarizedExecutable(join(folder, "memtrace")), true);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
