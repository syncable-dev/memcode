import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  open,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const appleKeys = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
  "APPLE_API_KEY_P8",
];
export function macReleasePolicy(env = process.env) {
  const mode = env.MEMCODE_MACOS_RELEASE_MODE ?? "public-release";
  if (
    !["public-release", "private-candidate", "manual-approval-beta"].includes(
      mode,
    )
  )
    throw Error(
      "Choose public-release, manual-approval-beta or private-candidate explicitly.",
    );
  if (mode !== "public-release")
    return {
      mode,
      publicReady: false,
      manualApprovalRequired: true,
      betaDistributionAllowed: mode === "manual-approval-beta",
    };
  for (const name of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
  ])
    if (!env[name]?.trim())
      throw Error(
        `Public macOS packaging requires protected ${name}. Use private-candidate only for an explicitly unnotarized test.`,
      );
  if (
    !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(
      env.APPLE_SIGNING_IDENTITY,
    )
  )
    throw Error(
      "Public macOS packaging requires a Developer ID Application identity.",
    );
  if (
    !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID) ||
    !env.APPLE_SIGNING_IDENTITY.endsWith(`(${env.APPLE_TEAM_ID})`)
  )
    throw Error("The Developer ID identity and Apple team must match.");
  const api = [
    env.APPLE_API_KEY,
    env.APPLE_API_ISSUER,
    env.APPLE_API_KEY_PATH || env.APPLE_API_KEY_P8,
  ];
  const hasApi = api.every((v) => Boolean(v?.trim()));
  if (api.some(Boolean) && !hasApi)
    throw Error("Apple API notarization credentials are incomplete.");
  if (!hasApi && !(env.APPLE_ID?.trim() && env.APPLE_PASSWORD?.trim()))
    throw Error(
      "Public macOS packaging requires complete notarization credentials.",
    );
  if (env.TAURI_SKIP_SIDECAR_SIGNATURE_CHECK === "true")
    throw Error("Public macOS packaging cannot skip sidecar signature checks.");
  return {
    mode,
    publicReady: false,
    teamId: env.APPLE_TEAM_ID,
    identity: env.APPLE_SIGNING_IDENTITY,
    authentication: hasApi ? "api-key" : "apple-id",
  };
}

// Never propagate execFileSync's error.message: it contains the argv, which can
// contain a certificate password during the short-lived keychain import.
function run(file, args, options = {}) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
      ...options,
    });
  } catch {
    throw Error(
      `macOS release verification failed during ${file.split("/").at(-1)}. See the named CI step; no credentials were logged.`,
    );
  }
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prepareMacSigning(root, inherited = process.env) {
  const policy = macReleasePolicy(inherited),
    env = { ...inherited, TAURI_BUNDLER_DMG_IGNORE_CI: "true" };
  if (process.platform !== "darwin")
    throw Error("Apple packaging must run on the native macOS build runner.");
  run("/usr/bin/swift", [
    join(root, "scripts/verify-dmg-background.swift"),
    join(root, "src-tauri/dmg-background.png"),
  ]);
  if (policy.mode !== "public-release") {
    for (const key of appleKeys) delete env[key];
    env.APPLE_SIGNING_IDENTITY = "-";
    return { policy, env, cleanup: async () => {} };
  }
  const temporary = await mkdtemp(join(tmpdir(), "memcode-signing-"));
  const keychain = join(temporary, "release.keychain-db"),
    password = randomBytes(32).toString("hex");
  const certificate = join(temporary, "certificate.p12");
  const originalKeychains = [
    ...run("/usr/bin/security", ["list-keychains", "-d", "user"]).matchAll(
      /"([^"\n]+)"/g,
    ),
  ].map((m) => m[1]);
  let created = false;
  const cleanup = async () => {
    try {
      if (created)
        run("/usr/bin/security", [
          "list-keychains",
          "-d",
          "user",
          "-s",
          ...originalKeychains,
        ]);
    } finally {
      try {
        if (created) run("/usr/bin/security", ["delete-keychain", keychain]);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  };
  try {
    const encoded = inherited.APPLE_CERTIFICATE.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw Error(
        "APPLE_CERTIFICATE must contain base64-encoded PKCS#12 material.",
      );
    await writeFile(certificate, Buffer.from(encoded, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    run("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    created = true;
    run("/usr/bin/security", [
      "set-keychain-settings",
      "-lut",
      "21600",
      keychain,
    ]);
    run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    run("/usr/bin/security", [
      "import",
      certificate,
      "-k",
      keychain,
      "-P",
      inherited.APPLE_CERTIFICATE_PASSWORD,
      "-T",
      "/usr/bin/codesign",
    ]);
    run("/usr/bin/security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    run("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychain,
      ...originalKeychains,
    ]);
    if (
      !run("/usr/bin/security", [
        "find-identity",
        "-v",
        "-p",
        "codesigning",
        keychain,
      ]).includes(policy.identity)
    )
      throw Error(
        "The imported certificate does not provide the configured Developer ID identity.",
      );
    delete env.APPLE_CERTIFICATE;
    delete env.APPLE_CERTIFICATE_PASSWORD;
    if (policy.authentication === "api-key" && inherited.APPLE_API_KEY_P8) {
      env.APPLE_API_KEY_PATH = join(temporary, "notary.p8");
      await writeFile(env.APPLE_API_KEY_PATH, inherited.APPLE_API_KEY_P8, {
        mode: 0o600,
        flag: "wx",
      });
    }
    delete env.APPLE_API_KEY_P8;
    // Resources are not Tauri externalBin entries. Sign Node explicitly before
    // the enclosing app is sealed. Node's MAP_JIT support needs only allow-jit.
    const node = join(root, "dist-desktop-runtime/node"),
      originalNode = await readFile(node);
    const provenance = JSON.parse(
      await readFile(
        join(root, "dist-desktop-runtime/provenance.json"),
        "utf8",
      ),
    );
    if (digest(originalNode) !== provenance.executableSha256)
      throw Error(
        "The staged Node executable differs from verified runtime provenance.",
      );
    run("/usr/bin/codesign", [
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      "--sign",
      policy.identity,
      "--keychain",
      keychain,
      "--entitlements",
      join(root, "src-tauri/entitlements.node.plist"),
      node,
    ]);
    run("/usr/bin/codesign", ["--verify", "--strict", node]);
    // Native libraries in the other bundled folders, such as onnxruntime for local
    // search, are loaded by that Node. Apple rejects the app while any is unsigned.
    const libraries = await bundledLibrariesToSign(root);
    for (const library of libraries) {
      run("/usr/bin/codesign", [
        "--force",
        "--timestamp",
        "--options",
        "runtime",
        "--sign",
        policy.identity,
        "--keychain",
        keychain,
        library,
      ]);
      run("/usr/bin/codesign", ["--verify", "--strict", library]);
    }
    await recordSignedFiles(root, libraries);
    const signedRuntime = {
      originalExecutableSha256: provenance.executableSha256,
      signedExecutableSha256: digest(await readFile(node)),
      teamId: policy.teamId,
      entitlements: ["com.apple.security.cs.allow-jit"],
    };
    return { policy, env, signedRuntime, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Writes the fingerprint of each signed file into the provenance.json of the bundled
 * folder it is in, keeping the unsigned one, since the app checks those files
 * against it before it loads them.
 */
export async function recordSignedFiles(root, signed) {
  const byFolder = new Map();
  for (const path of signed) {
    const [folder, ...rest] = relative(root, path).split(sep);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), rest.join("/")]);
  }
  for (const [folder, names] of byFolder) {
    const manifest = join(root, folder, "provenance.json");
    let provenance;
    try {
      provenance = JSON.parse(await readFile(manifest, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(provenance.files)) continue;
    for (const entry of provenance.files) {
      if (!names.includes(entry.name)) continue;
      const bytes = await readFile(join(root, folder, entry.name));
      entry.unsignedSha256 ??= entry.sha256;
      entry.bytes = bytes.length;
      entry.sha256 = digest(bytes);
    }
    await writeFile(manifest, JSON.stringify(provenance, null, 2) + "\n");
  }
}

/**
 * The native binaries in the folders packaging copies into the app as resources
 * (`dist-*` at the root), other than Node, which is signed with its own entitlement.
 */
export async function bundledLibrariesToSign(root) {
  const node = join(root, "dist-desktop-runtime/node");
  const folders = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("dist-"),
  );
  const found = await Promise.all(
    folders.map((folder) => machoFiles(join(root, folder.name))),
  );
  return found.flat().filter((path) => path !== node);
}

export async function machoFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await machoFiles(path)));
    else if (entry.isFile()) {
      const handle = await open(path, "r");
      try {
        const bytes = Buffer.alloc(4);
        if (
          (await handle.read(bytes, 0, 4, 0)).bytesRead === 4 &&
          [
            "feedface",
            "cefaedfe",
            "feedfacf",
            "cffaedfe",
            "cafebabe",
            "bebafeca",
            "cafebabf",
            "bfbafeca",
          ].includes(bytes.toString("hex"))
        )
          files.push(path);
      } finally {
        await handle.close();
      }
    }
  }
  return files;
}

export function assertPublicMacTrust(proof) {
  if (
    proof?.mode !== "public-release" ||
    proof.publicReady !== true ||
    proof.developerIdSigned !== true ||
    proof.notarized !== true ||
    proof.appGatekeeper !== "accepted" ||
    proof.dmgGatekeeper !== "accepted" ||
    proof.appTicket !== "validated" ||
    proof.dmgTicket !== "validated" ||
    proof.updaterAppTicket !== "validated" ||
    proof.updaterAppGatekeeper !== "accepted" ||
    proof.dmgLayoutVerified !== true ||
    proof.signedNodeJitSmoke !== "passed" ||
    proof.bundledEngineNativeTrust?.developerIdSigned !== true ||
    proof.bundledEngineNativeTrust?.gatekeeper !== "accepted" ||
    proof.bundledEngineNativeTrust?.nativeExecutables !== 4 ||
    !/^[A-Z0-9]{10}$/.test(proof.teamId ?? "") ||
    !(proof.nestedMachOCount >= 2)
  )
    throw Error(
      "This macOS candidate is not approved for public distribution. Developer ID, notarization, stapled tickets in app and updater, Gatekeeper, extracted engine trust and installer layout must all be verified.",
    );
  return proof;
}

export async function verifyMacRelease(root, signing) {
  if (process.platform !== "darwin")
    throw Error("macOS trust verification requires macOS.");
  const bundle = join(root, "src-tauri/target/release/bundle"),
    app = join(bundle, "macos/MemCode.app");
  const dmgs = (await readdir(join(bundle, "dmg"))).filter((n) =>
    n.endsWith(".dmg"),
  );
  if (dmgs.length !== 1) throw Error("Expected exactly one DMG.");
  const dmg = join(bundle, "dmg", dmgs[0]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const proof = {
    mode: signing.policy.mode,
    publicReady: false,
    developerIdSigned: false,
    notarized: false,
    manualApprovalRequired: signing.policy.mode !== "public-release",
    betaDistributionAllowed: signing.policy.mode === "manual-approval-beta",
    appGatekeeper: "not-established",
    dmgGatekeeper: "not-established",
    teamId: signing.policy.teamId ?? null,
    signedRuntime: signing.signedRuntime ?? null,
  };
  if (signing.policy.mode === "public-release") {
    // A signed/notarized container does not establish the trust of executables
    // hidden in an immutable archive and later extracted into a private profile.
    // Never rewrite vendor bytes or count the app signature as their signature.
    const engineDirectory = join(app, "Contents/Resources/memtrace-engine");
    const engineManifest = JSON.parse(await readFile(join(engineDirectory, "memcode-engine.json"), "utf8"));
    const engineArchive = join(engineDirectory, "engine.zip");
    const engineBytes = await readFile(engineArchive);
    if (digest(engineBytes) !== engineManifest.sha256)
      throw Error("The packaged engine archive differs from its reviewed manifest.");
    const engineTemp = await mkdtemp(join(tmpdir(), "memcode-engine-trust-"));
    try {
      run("/usr/bin/ditto", ["-x", "-k", engineArchive, engineTemp]);
      const names = ["memtrace", "memcore-server", "memcortex-daemon", "memcortex-mcp"];
      const { spawnSync } = await import("node:child_process");
      for (const name of names) {
        const binary = join(engineTemp, name);
        const expected = engineManifest.files.find(file => file.name === name);
        const info = await lstat(binary);
        if (!expected || !info.isFile() || info.isSymbolicLink() || digest(await readFile(binary)) !== expected.sha256)
          throw Error("An extracted engine executable differs from its reviewed manifest.");
        await chmod(binary, 0o700);
        run("/usr/bin/codesign", ["--verify", "--strict", binary]);
        const display = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", binary], { encoding: "utf8" });
        const details = display.stdout + display.stderr;
        if (display.status !== 0 || !details.includes("Authority=Developer ID Application:") || !details.includes("TeamIdentifier=" + proof.teamId) || !/flags=.*runtime/.test(details))
          throw Error("Public Mac distribution requires separately Developer ID signed, hardened and notarized engine executables. This bundled engine has not established that trust; use an explicitly labelled manual-approval beta until a trusted engine release is pinned.");
        run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", binary]);
      }
      proof.bundledEngineNativeTrust = { developerIdSigned: true, gatekeeper: "accepted", nativeExecutables: names.length, archiveSha256: engineManifest.sha256 };
    } finally {
      await rm(engineTemp, { recursive: true, force: true });
    }
    const actualNode = join(app, "Contents/Resources/desktop-runtime/node");
    if (
      digest(await readFile(actualNode)) !==
      signing.signedRuntime.signedExecutableSha256
    )
      throw Error("The bundled Node differs from the staged signed runtime.");
    const jitResult = run(
      actualNode,
      [
        "-e",
        "let sum=0;function add(x){return x+1}for(let i=0;i<500000;i++)sum+=add(i);if(sum!==125000250000)process.exit(1);process.stdout.write('jit-ok')",
      ],
      { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } },
    );
    if (jitResult !== "jit-ok")
      throw Error("The signed bundled Node failed its JIT execution smoke.");
    proof.signedNodeJitSmoke = "passed";
    const binaries = await machoFiles(app);
    proof.nestedMachOCount = binaries.length;
    for (const binary of [...binaries, app]) {
      run("/usr/bin/codesign", ["--verify", "--strict", binary]);
      // codesign writes metadata to stderr even on success.
      // Collect both streams without printing any content.
      const { spawnSync } = await import("node:child_process");
      const display = spawnSync(
        "/usr/bin/codesign",
        ["--display", "--verbose=4", binary],
        { encoding: "utf8" },
      );
      const details = display.stdout + display.stderr;
      if (
        display.status !== 0 ||
        !details.includes("Authority=Developer ID Application:") ||
        !details.includes("TeamIdentifier=" + proof.teamId) ||
        !/flags=.*runtime/.test(details)
      )
        throw Error(
          "A nested macOS binary lacks the expected Developer ID or hardened runtime.",
        );
    }
    const authentication =
      signing.policy.authentication === "api-key"
        ? [
            "--key",
            signing.env.APPLE_API_KEY_PATH,
            "--key-id",
            signing.env.APPLE_API_KEY,
            "--issuer",
            signing.env.APPLE_API_ISSUER,
          ]
        : [
            "--apple-id",
            signing.env.APPLE_ID,
            "--team-id",
            signing.env.APPLE_TEAM_ID,
            "--password",
            signing.env.APPLE_PASSWORD,
          ];
    const receipt = JSON.parse(
      run(
        "/usr/bin/xcrun",
        [
          "notarytool",
          "submit",
          dmg,
          ...authentication,
          "--wait",
          "--timeout",
          "30m",
          "--output-format",
          "json",
        ],
        { env: signing.env, timeout: 1900000 },
      ),
    );
    if (receipt.status !== "Accepted")
      throw Error("Apple did not accept the DMG for notarization.");
    run("/usr/bin/xcrun", ["stapler", "staple", dmg]);
    run("/usr/bin/xcrun", ["stapler", "validate", app]);
    proof.appTicket = "validated";
    run("/usr/bin/xcrun", ["stapler", "validate", dmg]);
    proof.dmgTicket = "validated";
    run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      app,
    ]);
    proof.appGatekeeper = "accepted";
    run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmg,
    ]);
    proof.dmgGatekeeper = "accepted";
    const updates = (await readdir(join(bundle, "macos"))).filter((name) =>
      name.endsWith(".app.tar.gz"),
    );
    if (updates.length !== 1)
      throw Error("Expected exactly one completed updater archive.");
    const updater = join(bundle, "macos", updates[0]);
    const names = run("/usr/bin/tar", ["-tzf", updater], {
      maxBuffer: 4 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
    if (
      names.some(
        (name) =>
          name.startsWith("/") ||
          name.split("/").includes("..") ||
          !name.startsWith("MemCode.app/"),
      )
    )
      throw Error("The updater archive contains an unexpected path.");
    const extracted = await mkdtemp(join(tmpdir(), "memcode-updater-trust-"));
    try {
      run("/usr/bin/tar", ["-xzf", updater, "-C", extracted]);
      const archivedApp = join(extracted, "MemCode.app");
      run("/usr/bin/codesign", ["--verify", "--deep", "--strict", archivedApp]);
      run("/usr/bin/xcrun", ["stapler", "validate", archivedApp]);
      proof.updaterAppTicket = "validated";
      run("/usr/sbin/spctl", [
        "--assess",
        "--type",
        "execute",
        "--verbose=4",
        archivedApp,
      ]);
      proof.updaterAppGatekeeper = "accepted";
    } finally {
      await rm(extracted, { recursive: true, force: true });
    }
    proof.developerIdSigned = true;
    proof.notarized = true;
    proof.notarySubmissionId = receipt.id;
  }
  // Mount the completed image read-only: do not accept CI's blank-Finder fallback.
  const mount = await mkdtemp(join(tmpdir(), "memcode-dmg-check-"));
  let attached = false;
  try {
    run("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
      dmg,
    ]);
    attached = true;
    if (!(await lstat(join(mount, "Applications"))).isSymbolicLink())
      throw Error("DMG Applications shortcut is missing.");
    if (!(await lstat(join(mount, "MemCode.app"))).isDirectory())
      throw Error("DMG app is missing.");
    const background = join(mount, ".background", "dmg-background.png");
    if (
      digest(await readFile(background)) !==
      digest(await readFile(join(root, "src-tauri/dmg-background.png")))
    )
      throw Error("DMG branded background is missing or differs.");
    if ((await readFile(join(mount, ".DS_Store"))).length < 128)
      throw Error("DMG Finder layout metadata is missing.");
    proof.dmgLayoutVerified = true;
  } finally {
    try {
      if (attached) run("/usr/bin/hdiutil", ["detach", mount]);
    } finally {
      await rm(mount, { recursive: true, force: true });
    }
  }
  if (signing.policy.mode === "public-release") {
    proof.publicReady = true;
    assertPublicMacTrust(proof);
  }
  await mkdir(join(root, "release"), { recursive: true });
  await writeFile(
    join(root, "release/macos-release-trust.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  return proof;
}
