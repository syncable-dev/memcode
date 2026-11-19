import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LocalStore, within } from "../runtime/local";
import { registerConnections } from "../runtime/worker-connections";
import { ManagedRetrievalAssistant } from "../runtime/context/managed-assistant";
import { SpeechManager } from "../runtime/speech";
import { createRuntime } from "../runtime/app";
import { contextAssistantDefaults } from "../src/context-settings";
import { initialState } from "../src/seed";
import type { AppState, Harness } from "../src/shared";

const harnesses: Harness[] = ["codex", "claude", "cursor"];
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "memcode-upgrade-retention-"));
  t.after(async () => {
    assert.ok(within(resolve(tmpdir()), resolve(root)));
    assert.ok(basename(root).startsWith("memcode-upgrade-retention-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function preferences(state: AppState) {
  return structuredClone({
    settings: state.settings,
    activeProjectId: state.activeProjectId,
    onboarding: state.onboarding,
    projectOnboarding: state.projectOnboarding,
    onboardingPreferences: state.onboardingPreferences,
    projects: state.projects,
    tasks: state.tasks,
    epics: state.epics,
    storyComments: state.storyComments,
    cycles: state.cycles,
    savedViews: state.savedViews,
    workflowStates: state.workflowStates,
    customFields: state.customFields,
  });
}

function savedState(
  profile: string,
  launcher: string,
  identities: Record<Harness, string>,
) {
  const state = initialState();
  const at = "2026-11-17T09:00:00.000Z";
  const project = {
    id: "synthetic-upgrade-project",
    name: "Synthetic upgrade fixture",
    description: "Disposable test data, never a user project",
    path: join(profile, "project"),
    branch: "epic/synthetic-upgrade",
    analysis: "idle" as const,
    createdAt: at,
  };
  const story = {
    ...structuredClone(state.tasks[0]),
    id: "synthetic-upgrade-story",
    projectId: project.id,
    identifier: "MC-001",
    title: "Synthetic saved story",
    description: "A saved multiline brief.\nPreserve this exact text.",
    epicId: "synthetic-upgrade-epic",
    stage: "planned" as const,
    example: false,
    messages: [
      {
        id: "synthetic-brief",
        role: "user" as const,
        text: "Preserve my saved brief",
        at,
      },
    ],
    run: { state: "idle" as const },
    permissionMode: "review" as const,
  };
  state.projects = [project];
  state.tasks = [story];
  state.activeProjectId = project.id;
  state.epics = [
    {
      id: story.epicId,
      projectId: project.id,
      identifier: "EP-01",
      title: "Synthetic saved epic",
      description: "Local-only fixture",
      phase: "now",
      color: "mint",
      order: 0,
      branch: project.branch,
    },
  ];
  state.storyComments = [
    {
      id: "synthetic-comment",
      taskId: story.id,
      text: "Keep this review note.\nAnd its newline.",
      author: { id: "synthetic-author", name: "Synthetic QA", source: "local" },
      createdAt: at,
      updatedAt: at,
    },
  ];
  state.settings = {
    ...state.settings,
    defaultHarness: "cursor",
    model: "saved-provider-model",
    maxWorkers: 7,
    workerPermissionDefaults: {
      codex: "auto",
      claude: "full-access",
      cursor: "review",
    },
    speechEndpoint: "http://127.0.0.1:8181",
    speech: {
      mode: "managed",
      language: "da",
      executable: join(profile, "speech", "whisper-server"),
      modelPath: join(profile, "speech", "ggml-tiny.bin"),
    },
    contextAssistant: { ...contextAssistantDefaults, enabled: true },
  };
  state.workerConnections = Object.fromEntries(
    harnesses.map((harness) => [
      harness,
      {
        harness,
        runtimePath: launcher,
        runtimeIdentity: identities[harness],
        scopeVersion: 1,
        approvedAt: at,
        auth: "authenticated",
        accountLabel: "synthetic@example.invalid",
      },
    ]),
  ) as AppState["workerConnections"];
  state.onboarding = {
    version: 1,
    step: "ready",
    projectId: project.id,
    epicId: story.epicId,
    storyId: story.id,
    dismissed: true,
    completedAt: at,
  };
  state.projectOnboarding = { [project.id]: structuredClone(state.onboarding) };
  state.onboardingPreferences = { showForNewProjects: false };
  return state;
}

test("an approved workspace survives an app resource move and two restarts with all defaults and model choices", async (t) => {
  const root = await directory(t),
    profile = join(root, "private-profile");
  await mkdir(profile);
  await mkdir(join(profile, "project"));
  const oldHost = join(
    root,
    "downloaded-beta10",
    "MemCode.app",
    "Contents",
    "Resources",
    "desktop-runtime",
    basename(process.execPath),
  );
  const newHost = join(
    root,
    "Applications",
    "MemCode.app",
    "Contents",
    "Resources",
    "desktop-runtime",
    basename(process.execPath),
  );
  for (const host of [oldHost, newHost]) {
    await mkdir(join(host, ".."), { recursive: true });
    // Homebrew Node must resolve its shared libraries from its installation.
    if (process.platform === "win32")
      await copyFile(process.execPath, host, constants.COPYFILE_FICLONE);
    else await symlink(process.execPath, host);
  }
  const identities = Object.fromEntries(
    harnesses.map((h) => [h, join(root, "providers", h, "cli.mjs")]),
  ) as Record<Harness, string>;
  const script = join(root, "read-only-provider-fixture.mjs"),
    audit = join(root, "auth-probes.ndjson");
  await writeFile(
    script,
    `import{appendFileSync}from'node:fs';const[h,...args]=process.argv.slice(2);const expected=h==='codex'?'login status':h==='claude'?'auth status':'status --format json';if(args.join(' ')!==expected)process.exit(23);appendFileSync(${JSON.stringify(audit)},JSON.stringify({h,args})+'\\n');if(h==='codex')console.error('Logged in using ChatGPT');else console.log(JSON.stringify(h==='claude'?{loggedIn:true,email:'synthetic@example.invalid'}:{isAuthenticated:true,userInfo:{email:'synthetic@example.invalid'}}));`,
  );
  const original = new LocalStore(profile);
  original.state = savedState(profile, oldHost, identities);
  await original.save();
  const expected = preferences(original.state),
    approvedAt = original.state.workerConnections!.codex!.approvedAt;
  for (let restart = 0; restart < 2; restart++) {
    const restored = new LocalStore(profile);
    await restored.load();
    assert.deepEqual(preferences(restored.state), expected);
    const routes = new Map<
      string,
      { schema: any; handler: (input: any) => any }
    >();
    const registry = registerConnections(
      (name, schema, handler) => routes.set(name, { schema, handler }),
      () => restored.state,
      () => restored.save(),
      () => join(root, "no-memtrace-fixture"),
      { call: async () => undefined as any },
      async (name) => ({
        command: newHost,
        prefix: [script, name],
        identity: identities[name as Harness],
      }),
    );
    try {
      const statusRoute = routes.get("connection:status")!;
      const statuses = await statusRoute.handler(
        statusRoute.schema.parse(undefined),
      );
      assert.equal(statuses.length, 3);
      assert.ok(
        statuses.every((status: any) => status.connected),
        "Changing only the MemCode Node/resource path must not revoke provider consent.",
      );
      for (const harness of harnesses)
        assert.equal(
          restored.state.workerConnections![harness]!.approvedAt,
          approvedAt,
        );
      assert.deepEqual(preferences(restored.state), expected);
      assert.ok(
        restored.state.tasks.every((task) => task.run.state === "idle"),
      );
      await restored.save();
    } finally {
      await registry.close();
    }
  }
  const calls = (await readFile(audit, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    calls.length,
    6,
    "Only the six read-only synthetic provider authentication probes ran.",
  );
  assert.equal(
    new LocalStore(profile).state.workerConnections,
    undefined,
    "Fresh profiles still have no automatic consent.",
  );
});

test("retrieval cache receipts stay valid when only the packaged inference runtime location changes", async (t) => {
  const root = await directory(t),
    profile = join(root, "private-profile");
  const oldRuntime = join(root, "downloaded-app", "retriever-runtime"),
    newRuntime = join(root, "Applications", "retriever-runtime");
  const entry =
    "node_modules/@huggingface/transformers/dist/transformers.node.mjs";
  const code = Buffer.from(
    "// Synthetic runtime fixture; no real inference is claimed.\n",
  );
  for (const runtime of [oldRuntime, newRuntime]) {
    await mkdir(join(runtime, "node_modules/@huggingface/transformers/dist"), {
      recursive: true,
    });
    await writeFile(join(runtime, entry), code);
    await writeFile(
      join(runtime, "provenance.json"),
      JSON.stringify({
        schema: 1,
        version: "4.3.2",
        platform: "darwin",
        arch: "arm64",
        entry,
        files: [{ name: entry, bytes: code.length, sha256: hash(code) }],
      }),
    );
  }
  const weights = Buffer.from(
    "Synthetic model receipt fixture, not model weights",
  );
  const modelManifest = {
    id: "synthetic/retrieval",
    revision: "synthetic-fixed-revision",
    runtimeVersion: "4.3.2",
    assets: [
      {
        name: "model.onnx",
        bytes: weights.length,
        sha256: hash(weights),
        url: "https://models.invalid/model.onnx",
      },
    ],
  };
  let downloads = 0;
  const createAssistant = () => ({
    model: "synthetic/retrieval",
    plan: async (query: string) => ({ query }),
    rank: async () => ({ ids: [] }),
  });
  const installed = new ManagedRetrievalAssistant(profile, {
    runtimeDirectory: oldRuntime,
    modelManifest,
    platform: "darwin",
    arch: "arm64",
    createAssistant,
    fetch: (async () => {
      downloads++;
      return new Response(weights, {
        headers: { "content-length": String(weights.length) },
      });
    }) as typeof fetch,
  });
  assert.equal((await installed.install()).status, "ready");
  const receipt = join(
    profile,
    "local-retriever",
    modelManifest.revision,
    "ready.json",
  );
  const before = await readFile(receipt);
  await installed.close();
  const restored = new ManagedRetrievalAssistant(profile, {
    runtimeDirectory: newRuntime,
    modelManifest,
    platform: "darwin",
    arch: "arm64",
    createAssistant,
    fetch: (async () => {
      throw Error("A restarted cached fixture must not download");
    }) as typeof fetch,
  });
  try {
    assert.equal((await restored.status()).status, "ready");
    assert.equal(restored.modelDirectory, installed.modelDirectory);
    assert.deepEqual(await readFile(receipt), before);
    assert.equal(downloads, 1);
  } finally {
    await restored.close();
  }
});

test("saved dictation executable, language and model bytes survive profile restart", async (t) => {
  const root = await directory(t),
    profile = join(root, "private-profile"),
    store = new LocalStore(profile);
  const identities = Object.fromEntries(
    harnesses.map((h) => [h, `synthetic-provider:${h}`]),
  ) as Record<Harness, string>;
  store.state = savedState(
    profile,
    "/Volumes/MemCode/MemCode.app/Contents/Resources/desktop-runtime/node",
    identities,
  );
  const speech = store.state.settings.speech!,
    bytes = Buffer.from("Synthetic speech cache fixture, not real weights");
  await mkdir(join(profile, "speech"), { recursive: true });
  await writeFile(speech.executable, "Synthetic runtime fixture");
  await writeFile(speech.modelPath, bytes);
  await store.save();
  const restored = new LocalStore(profile);
  await restored.load();
  const manager = new SpeechManager(
    () => restored.state.settings,
    profile,
    async () =>
      assert.fail("Read-only startup must not replace dictation settings"),
  );
  try {
    const status = await manager.status();
    assert.equal(status.state, "available");
    assert.equal(status.settings.language, "da");
    assert.deepEqual(status.settings, speech);
    assert.equal(hash(await readFile(status.settings.modelPath)), hash(bytes));
  } finally {
    await manager.close();
  }
});

test("a settings dialog opened before model setup cannot erase newly persisted model preferences", async (t) => {
  const root = await directory(t),
    profile = join(root, "private-profile"),
    initial = new LocalStore(profile);
  await mkdir(profile);
  initial.state.settings.memtracePath = join(root, "no-memtrace-fixture");
  await initial.save();
  const runtime = await createRuntime(
    profile,
    root,
    { call: async () => undefined as any },
    () => {},
    { discoverHarnesses: async () => [] },
  );
  try {
    const dialogOpenedBeforeSetup = structuredClone(
      runtime.store.state.settings,
    );
    const speech = {
      mode: "managed" as const,
      executable: join(profile, "speech", "whisper-server"),
      modelPath: join(profile, "speech", "ggml-tiny.bin"),
      language: "da",
    };
    const retrieval = {
      ...contextAssistantDefaults,
      enabled: true,
      provider: "openai-compatible" as const,
    };
    // Represents the independently completed setup actions while a global
    // Settings dialog still holds its earlier snapshot. No model is downloaded.
    runtime.store.state.settings.speech = speech;
    runtime.store.state.settings.contextAssistant = retrieval;
    await runtime.store.save();
    await runtime.request("settings:save", {
      ...dialogOpenedBeforeSetup,
      model: "new-provider-choice",
    });
    assert.deepEqual(runtime.store.state.settings.speech, speech);
    assert.deepEqual(runtime.store.state.settings.contextAssistant, retrieval);
    const restarted = new LocalStore(profile);
    await restarted.load();
    assert.deepEqual(restarted.state.settings.speech, speech);
    assert.deepEqual(restarted.state.settings.contextAssistant, retrieval);
    assert.equal(restarted.state.settings.model, "new-provider-choice");
  } finally {
    await runtime.close();
  }
});

test("the dedicated retrieval choice persists enable and disable immediately across runtime restarts", async (t) => {
  const root = await directory(t),
    profile = join(root, "private-profile");
  await mkdir(profile);
  const saved = new LocalStore(profile);
  saved.state.settings.memtracePath = join(root, "no-memtrace-fixture");
  await saved.save();
  for (const enabled of [true, false]) {
    const runtime = await createRuntime(
      profile,
      root,
      { call: async () => undefined as any },
      () => {},
      { discoverHarnesses: async () => [] },
    );
    try {
      await runtime.request("retrieval:configure", {
        ...contextAssistantDefaults,
        enabled,
      });
      const disk = new LocalStore(profile);
      await disk.load();
      assert.deepEqual(disk.state.settings.contextAssistant, {
        ...contextAssistantDefaults,
        enabled,
      });
      assert.equal(
        runtime.store.state.settings.contextAssistant?.enabled,
        enabled,
      );
    } finally {
      await runtime.close();
    }
  }
  const restarted = new LocalStore(profile);
  await restarted.load();
  assert.equal(restarted.state.settings.contextAssistant?.enabled, false);
});
