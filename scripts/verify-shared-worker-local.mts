// Explicit local acceptance run. Uses installed/authenticated coding harnesses.
// No personal board is changed; all code edits stay in a disposable lab repo.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { initialState } from "../src/seed.ts";
import { MemtraceEngine } from "../runtime/memtrace.ts";
import { WorkerManager } from "../runtime/workers.ts";
import { discoverHarnesses } from "../runtime/catalog.ts";
import { commandIdentity, findCommand } from "../runtime/commands.ts";
import { CodeReviewManager } from "../runtime/code-review.ts";
import { createReadonlyReviewAgent } from "../runtime/review-agent.ts";
import {
  prepareReviewAnalysis,
  repairReviewPublication,
} from "../runtime/review-analysis-prepare.ts";
import { epicAnalysisProject } from "../runtime/epic-checkout.ts";
import { initializeCodeReviewWorkflow } from "../src/code-review-workflow.ts";
import { TeamSyncClient } from "../runtime/team/client.ts";

const harness = process.env.QA_HARNESS ?? "claude";
const small = process.env.QA_SMALL === "1";
assert.ok(["claude", "codex", "cursor"].includes(harness));
const reuse = process.env.QA_REUSE;
const retryCoding = process.env.QA_RETRY_CODING === "1";
const root =
  reuse ?? (await mkdtemp(join(tmpdir(), "memcode-real-shared-worker-")));
const checkout = join(root, "code"),
  profile = join(root, "host"),
  receipt = join(root, "receipt.json");
const previous = reuse
  ? JSON.parse(await readFile(receipt, "utf8"))
  : undefined;
if (previous)
  await writeFile(
    join(root, `receipt-${Date.now()}.json`),
    JSON.stringify(previous, null, 2),
  );
if (!reuse) {
  await mkdir(checkout);
  await mkdir(profile);
  if (small) {
    await mkdir(join(checkout, "src"));
    await writeFile(join(checkout, ".gitignore"), "node_modules/\n.memcode/\n");
    await writeFile(
      join(checkout, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
        },
        include: ["src"],
      }),
    );
    await writeFile(
      join(checkout, "src/totals.ts"),
      "export function total(values: Array<number|string>): number { return values.reduce<any>((sum,value)=>sum+value,0); }\nexport function mean(values:Array<number|string>):number { return total(values)/values.length; }\n",
    );
    await writeFile(
      join(checkout, "totals.test.mjs"),
      "import test from 'node:test';import assert from 'node:assert/strict';import {total,mean} from './src/totals.ts';test('numbers and numeric strings',()=>{assert.equal(total([2,'3',0]),5);assert.equal(mean(['2',4]),3);});test('empty and invalid inputs',()=>{assert.equal(mean([]),0);assert.throws(()=>total(['no']),/finite|invalid|number/i);assert.throws(()=>mean([Infinity]),/finite|invalid|number/i);});\n",
    );
  } else {
    const archive = execFileSync("git", ["archive", "HEAD"], {
      maxBuffer: 100 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", checkout], { input: archive });
  }
}
// Use ordinary installed files, as a downloaded app's project does. A junction
// to another project's dependencies is deliberately refused by native source
// certification and would test an unsupported fixture rather than the product.
const installDependencies = async (workspace: string) => {
  if (small) {
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await cp(
      resolve("node_modules/typescript"),
      join(workspace, "node_modules/typescript"),
      { recursive: true },
    );
    await cp(
      resolve("node_modules/@typescript"),
      join(workspace, "node_modules/@typescript"),
      { recursive: true },
    );
  } else
    await cp(resolve("node_modules"), join(workspace, "node_modules"), {
      recursive: true,
    });
};
await installDependencies(checkout);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
if (!reuse) {
  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=MemCode Local Acceptance",
    "-c",
    "user.email=qa@localhost",
    "commit",
    "-m",
    "Real MemCode source baseline for local worker acceptance",
  );
}
const descriptor = JSON.parse(
  await readFile(process.env.QA_ENGINE_PROOF!, "utf8"),
);
const proofFile = join(profile, "access.jwt");
await writeFile(proofFile, descriptor.accessProof, { mode: 0o600 });
const engine = new MemtraceEngine(() => process.env.QA_ENGINE_BINARY!, {
  privateProject: () => true,
  managedGraphRoot: join(profile, "memtrace-projects"),
  environment: async () => ({
    MEMTRACE_SKIP_EMBED: "1",
    MEMCODE_ENGINE_ACCESS_FILE: proofFile,
    MEMCODE_ENGINE_SESSION_ID: descriptor.sessionId,
    MEMCODE_ENGINE_DEVICE_ID: descriptor.deviceId,
  }),
});
const state = reuse
    ? JSON.parse(await readFile(join(profile, "workspace.json"), "utf8"))
    : initialState(),
  now = new Date().toISOString();
const project: any = reuse
  ? state.projects[0]
  : {
      id: "real-code",
      name: "Real shared worker acceptance",
      description: "Isolated local acceptance",
      path: checkout,
      branch: "main",
      analysis: "idle",
      createdAt: now,
    };
const task: any = reuse
  ? state.tasks[0]
  : {
      ...state.tasks[0],
      id: "real-large-task",
      projectId: project.id,
      identifier: "QA-LARGE",
      title: "Reduce WorkDetail complexity without changing behavior",
      example: false,
      stage: "planned",
      epicId: null,
      cycleId: null,
      assignment: "manual",
      harness,
      modelOverride: process.env.QA_MODEL ?? "opus",
      permissionMode: "full-access",
      scope: [
        "src/components/WorkDetail.tsx",
        "src/components/WorkDetailHeader.tsx",
        "src/components/StoryRunbook.tsx",
        "src/components/ConversationComposer.tsx",
        "src/components/WorkDetailArtifacts.tsx",
        "src/components/WorkInspectorSections.tsx",
      ],
      checklist: [],
      run: { state: "idle" },
      createdAt: now,
      updatedAt: now,
      description:
        "Refactor the real large WorkDetail component by extracting cohesive presentation sections or hooks into lean modules. Preserve tab behavior, browser, terminal, review, queued follow-ups and accessibility. Reduce its cognitive and cyclomatic complexity meaningfully. Use MemCode context and Fleet for discovery/coordination. Run the TypeScript check and relevant EXISTING tests. Do not build a new browser/snapshot harness: native UI acceptance is a separate gate. Bound each command to 60 seconds and bound the whole coding pass to 8 minutes. Do not install packages, change licenses, or change unrelated source. This is an isolated acceptance checkout. Record the checks you actually ran. Stop when the refactor and verification are complete.",
      messages: [],
    };
if (!reuse)
  task.messages = [
    { id: "brief", role: "user", text: task.description, at: now },
  ];
if (small && !reuse) {
  task.title = "Fix numeric totals and means";
  task.identifier = "QA-ADAPTER";
  task.scope = ["src/totals.ts"];
  task.description =
    "Fix numeric totals and means in src/totals.ts. Numeric strings must be converted to numbers before addition. Empty mean is zero. Invalid/nonfinite inputs must throw a clear error. Preserve the tests and exported signatures. Use MemCode context and Fleet where relevant. Run node --test totals.test.mjs and node node_modules/typescript/bin/tsc --noEmit. Do not add a framework, browser tests, install packages, or change unrelated files. Use bounded commands under 60 seconds. Report actual checks and finish.";
  task.messages[0].text = task.description;
}
if (!reuse)
  Object.assign(state, {
    projects: [project],
    tasks: [task],
    epics: [],
    cycles: [],
    artifacts: [],
    team: [],
    activeProjectId: project.id,
  });
state.settings.maxWorkers = 3;
state.settings.localModel = false;
initializeCodeReviewWorkflow(state, project.id);
let changedCount = 0,
  mirrorCount = 0;
const result: any = {
  root,
  fixture: small
    ? "Small numeric fixture and real provider. No production story modified."
    : "Real MemCode source and real provider. No production story modified.",
  platform: process.platform,
  harness,
  startedAt: now,
  passed: false,
};
let lastLabel = "",
  reviewers: CodeReviewManager | undefined;
let team: TeamSyncClient, peer: TeamSyncClient;
const peerState = initialState();
Object.assign(peerState, {
  projects: [{ ...project, id: "peer", path: null }],
  tasks: [],
  epics: [],
  cycles: [],
  team: [],
  activeProjectId: "peer",
});
const persist = async () => {
  await team?.capture();
  if (task.run.workspace && task.run.workspace !== checkout) {
    const dependencies = join(task.run.workspace, "node_modules");
    if (
      !(await access(dependencies).then(
        () => true,
        () => false,
      ))
    )
      await installDependencies(task.run.workspace);
  }
  changedCount++;
  if (task.run.activity?.label && lastLabel !== task.run.activity.label) {
    lastLabel = task.run.activity.label;
    console.log(lastLabel);
  }
  await writeFile(join(profile, "workspace.json"), JSON.stringify(state));
};
const workers = new WorkerManager(
  () => state,
  persist,
  engine,
  profile,
  findCommand,
  (only) => discoverHarnesses(false, only),
  undefined,
  undefined,
  undefined,
  {
    acquire: (id, pid) => team.acquire(id, pid),
    release: (id, pid) => team.release(id, pid),
    prepareFollowups: (item) => team.prepareFollowups(item),
  },
);
team = new TeamSyncClient(() => state, profile, persist, {
  background: false,
  loadReview: (id) => reviewers?.get(id) ?? Promise.resolve(null),
  onSessionCommand: async (item, command) => {
    if (command.kind === "review-start") {
      await reviewers!.start(item.id);
      return;
    }
    if (command.kind === "review-question") {
      await reviewers!.discuss(item.id, command.reviewRunId!, command.text, {
        id: command.id,
        actor: command.author,
      });
      return;
    }
    if (command.kind !== "followup") return;
    if (!item.messages.some((m) => m.id === command.id)) {
      item.messages.push({
        id: command.id,
        sourceCommandId: command.id,
        role: "user",
        text: command.text,
        at: command.createdAt,
        actor: command.author,
      });
      workers.enqueue(item, command.id);
      await persist();
    }
  },
});
peer = new TeamSyncClient(
  () => peerState,
  join(root, "peer"),
  async () => {
    mirrorCount++;
  },
  { background: false },
);
const sync = setInterval(() => {
  void team
    .synchronize(project.id)
    .then(() => peer.synchronize("peer"))
    .catch((error) => {
      result.lastSyncError = error.message;
    });
}, 1000);
try {
  await team.initialize();
  await peer.initialize();
  const catalog = await discoverHarnesses(true, harness as any),
    runtime = catalog.find((r) => r.id === harness)!;
  assert.ok(
    runtime?.path,
    "Install and authenticate the selected harness first",
  );
  const command = await findCommand(harness);
  assert.ok(command);
  state.workerConnections = {
    [harness]: {
      harness,
      runtimePath: runtime.path,
      runtimeIdentity: commandIdentity(command),
      scopeVersion: 1,
      approvedAt: now,
      auth: "authenticated",
    },
  } as any;
  result.catalog = runtime.models?.map((m) => m.id);
  if (retryCoding) {
    assert.ok(reuse, "Retry a saved lab only after its previous run has ended");
    task.scope = [
      "src/components/WorkDetail.tsx",
      "src/components/WorkDetailHeader.tsx",
      "src/components/StoryRunbook.tsx",
      "src/components/ConversationComposer.tsx",
      "src/components/WorkDetailArtifacts.tsx",
      "src/components/WorkInspectorSections.tsx",
    ];
    task.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      at: now,
      text: "Continue the real refactor now. The declared Fleet scope has been corrected to the exact files WorkDetail.tsx, WorkDetailHeader.tsx, StoryRunbook.tsx, ConversationComposer.tsx, WorkDetailArtifacts.tsx and WorkInspectorSections.tsx, all under src/components. Use only these filenames for extracted components. Obtain coordinate(inspect) approval before editing and checkpoint afterward. Run the existing relevant tests and typecheck. Do not build a new test harness or add packages. Finish this bounded implementation pass.",
    });
    task.updatedAt = now;
    await persist();
    await team.synchronize(project.id);
    assert.ok(
      task.scope.every((path: string) => /\.[a-z]+$/i.test(path)),
      "The restored lab must retain its corrected exact file scope",
    );
  }
  if (!reuse) {
    await team.create({
      projectId: project.id,
      displayName: "Local host test",
    });
    await peer.join({
      projectId: "peer",
      displayName: "Second member test",
      invite: JSON.stringify(await team.invite(project.id)),
    });
    project.repoId = await engine.analyze(project, (note) => console.log(note));
    project.analysis = "ready";
    result.analysisReadyAt = new Date().toISOString();
    await workers.start(task, project);
  }
  if (retryCoding) await workers.start(task, project);
  const deadline = Date.now() + 15 * 60_000;
  let followup: string | undefined = retryCoding
    ? undefined
    : previous?.remoteFollowup;
  if (followup) result.remoteFollowup = followup;
  while (["preparing", "running", "stopping"].includes(task.run.state)) {
    assert.ok(Date.now() < deadline, "Real coding task exceeded 15 minutes");
    await team.synchronize(project.id);
    await peer.synchronize("peer");
    if (
      !followup &&
      peerState.tasks[0]?.sharedSession?.messages.some(
        (m) => m.role === "assistant",
      )
    ) {
      followup = await peer.sendSessionCommand(
        task.id,
        "followup",
        "Keep the refactor focused. Include the exact validation commands and outcomes in your final response.",
      );
      result.remoteFollowup = followup;
    }
    await new Promise((done) => setTimeout(done, 700));
  }
  result.worker = {
    state: task.run.state,
    error: task.run.error,
    measurements: task.run.measurements,
    changedCount,
  };
  assert.equal(
    task.run.state,
    "finished",
    task.run.error ?? "The worker did not finish",
  );
  // Sending a peer follow-up authorizes the next real provider turn.
  workers.dispatchQueued();
  while (
    task.messages.some((m) => m.followupState === "queued" && !m.promptedAt) ||
    ["preparing", "running", "stopping"].includes(task.run.state)
  ) {
    assert.ok(
      Date.now() < deadline,
      "Follow-up continuation exceeded the acceptance deadline",
    );
    await team.synchronize(project.id);
    await peer.synchronize("peer");
    await new Promise((done) => setTimeout(done, 700));
  }
  assert.equal(
    task.run.state,
    "finished",
    task.run.error ?? "The continuation did not finish",
  );
  while (workers.implementationStarting(task.id)) {
    assert.ok(
      Date.now() < deadline,
      "The worker contribution did not finish settling",
    );
    await new Promise((done) => setTimeout(done, 100));
  }
  console.log(
    "Coding and queued continuation finished; independently checking the code.",
  );
  execFileSync(
    process.execPath,
    [
      join(task.run.workspace ?? checkout, "node_modules/typescript/bin/tsc"),
      "--noEmit",
    ],
    { cwd: task.run.workspace ?? checkout, encoding: "utf8", timeout: 120000 },
  );
  if (small)
    execFileSync(process.execPath, ["--test", "totals.test.mjs"], {
      cwd: task.run.workspace ?? checkout,
      encoding: "utf8",
      timeout: 60000,
    });
  result.typecheck = true;
  task.stage = "review";
  task.statusId = state.reviewWorkflows[project.id].codeReviewStatusId;
  await persist();
  await team.synchronize(project.id);
  reviewers = new CodeReviewManager(profile, () => state, engine, persist, {
    implementationCount: () => workers.implementationCount(),
    implementationStarting: (id) => workers.implementationStarting(id),
    queueFixes: async () => {
      throw Error("Acceptance preserves the review");
    },
    accept: async () => {},
    engineVersion: (p) => engine.versionFor(p.id) ?? "Not reported",
    reviewProject: (item, p) => epicAnalysisProject(p, item),
    prepare: async (item, p, update, active) => {
      const prepared = await prepareReviewAnalysis(engine, p, update, active);
      item.run.analysisRepoId = prepared.repoId;
      return prepared;
    },
    repairPublication: async (_item, p, update, active, revision) => {
      await repairReviewPublication(engine, p, update, active, revision);
    },
    reviewer: createReadonlyReviewAgent(profile, () => state),
    onSaved: (run) => team.reviewSaved(run),
  });
  const reviewStarted = Date.now();
  await peer.synchronize("peer");
  await peer.sendSessionCommand(
    task.id,
    "review-start",
    "Review this completed story on the executing device.",
  );
  await team.synchronize(project.id);
  let review;
  do {
    review = await reviewers.get(task.id);
    assert.ok(
      Date.now() - reviewStarted < 6 * 60_000,
      "Review exceeded six minutes",
    );
    await new Promise((done) => setTimeout(done, 500));
  } while (!review || ["queued", "running"].includes(review.state));
  result.review = {
    state: review.state,
    note: review.note,
    durationMs: Date.now() - reviewStarted,
    metrics: review.metrics,
    coverage: review.coverage,
    reviewer: review.reviewer,
    phases: review.phases,
  };
  assert.equal(
    review.state,
    "completed",
    review.note ?? "Review did not complete",
  );
  assert.ok(
    review.metrics.length > 1,
    "Real extraction should expose multiple changed functions",
  );
  await team.synchronize(project.id);
  await peer.synchronize("peer");
  const reviewQuestion = await peer.sendSessionCommand(
    task.id,
    "review-question",
    "Explain the measured changes and remaining verification limits in two sentences.",
    review.id,
  );
  await team.synchronize(project.id);
  while (
    !review.messages.some((m) => m.id === reviewQuestion) ||
    review.messages.at(-1)?.role !== "assistant"
  ) {
    await peer.synchronize("peer");
    const command = peerState.tasks[0]?.sessionCommands?.find(
      (c) => c.id === reviewQuestion,
    );
    assert.notEqual(
      command?.state,
      "failed",
      command?.error ?? "Remote review question failed",
    );
    assert.ok(
      Date.now() - reviewStarted < 6 * 60_000,
      "Remote review answer exceeded its deadline",
    );
    await new Promise((done) => setTimeout(done, 500));
    review = (await reviewers.get(task.id))!;
  }
  result.reviewQuestion = reviewQuestion;
  await team.synchronize(project.id);
  await peer.synchronize("peer");
  const shared = peerState.tasks[0].sharedSession!;
  assert.equal(shared.harness, harness);
  assert.equal(shared.review?.id, review.id);
  assert.equal(shared.review?.metrics.length, review.metrics.length);
  assert.ok(
    shared.messages.some(
      (m) =>
        m.sourceCommandId === followup &&
        m.actor?.name === "Second member test",
    ),
  );
  result.shared = {
    actualModel: shared.actualModel,
    owner: shared.owner,
    transcriptMessages: shared.messages.length,
    reviewId: shared.review?.id,
    mirrorCount,
  };
  result.passed = true;
} catch (error) {
  result.error = String((error as Error).message);
  console.log(result.error);
  process.exitCode = 1;
} finally {
  clearInterval(sync);
  await workers.close();
  await reviewers?.close();
  await Promise.allSettled([peer.close(), team.close()]);
  await engine.close();
  await unlink(proofFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  result.finishedAt = new Date().toISOString();
  await writeFile(receipt, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({ receipt, passed: result.passed, error: result.error }),
  );
}
