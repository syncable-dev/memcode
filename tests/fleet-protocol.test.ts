import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { FleetCoordinator, FleetBlocked } from "../runtime/fleet";
import { git, within } from "../runtime/local";
import { rereadFleetSource } from "../runtime/fleet-source";
import type { MemtraceEngine } from "../runtime/memtrace";
import type { WorkItem } from "../src/shared";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "memcode-fleet-protocol-")),
  );
  await git(root, ["init", "--initial-branch=main"]);
  await writeFile(
    join(root, "shared.ts"),
    "export const contract = 'first plan';\n",
  );
  const state = initialState(),
    project = {
      ...state.projects[0],
      id: "protocol",
      path: root,
      repoId: "protocol",
      analysis: "ready" as const,
      example: false,
    };
  state.projects = [project];
  state.fleetConflicts = [];
  const tasks = state.tasks.slice(0, 3).map(
    (task, index) =>
      ({
        ...task,
        id: "worker-" + index,
        projectId: project.id,
        epicId: "shared",
        example: false,
        scope: [index === 2 ? "unrelated.ts" : "shared.ts"],
        messages: [],
        run: { state: "running", branch: "main", workspace: root },
      }) as WorkItem,
  );
  state.tasks = tasks;
  const intents = new Map<string, string[]>(),
    leases = new Map<string, { agent: string; scope: string[] }>(),
    paused: string[][] = [];
  let episode = "B";
  const engine = {
    call: async (_project: unknown, name: string, args: any) => {
      if (name === "fleet_preflight")
        return {
          active_conflicts: [...intents]
            .filter(
              ([agent, scope]) =>
                agent !== args.agent_id &&
                scope.some((key) => args.touched.includes(key)),
            )
            .map(([agent_id]) => ({ agent_id })),
        };
      if (name === "fleet_publish_intent") {
        if (args.touched.length) intents.set(args.agent_id, args.touched);
        else intents.delete(args.agent_id);
        return { active_conflicts: [] };
      }
      if (name === "fleet_acquire_lease") {
        const blocked = [...leases.values()].some(
          (lease) =>
            lease.agent !== args.agent_id &&
            lease.scope.some((key) => args.scope.includes(key)),
        );
        if (blocked) return { state: "requested" };
        const lease_id = "lease-" + args.agent_id;
        leases.set(lease_id, { agent: args.agent_id, scope: args.scope });
        return { state: "granted", lease_id };
      }
      if (name === "fleet_release_lease") {
        leases.delete(args.lease_id);
        return {};
      }
      if (name === "fleet_record_episode")
        return { conflict_class: episode, replan_hint: "re-read" };
      return {};
    },
  } as unknown as MemtraceEngine;
  const fleet = new FleetCoordinator(
    () => state,
    engine,
    async () => {},
    (ids) => {
      paused.push(ids);
    },
  );
  for (const task of tasks) await fleet.before(project, task);
  return {
    root,
    state,
    project,
    tasks,
    fleet,
    paused,
    release: async () => {
      for (const task of tasks) await fleet.release(project, task);
    },
  };
}

test("first published plan wins; accepted alternatives reconcile without human conflict; Class B rereads", async () => {
  const f = await fixture();
  try {
    const [owner, later] = f.tasks;
    const first = await f.fleet.coordinate(f.project, owner, {
      action: "inspect",
      plan: "Preserve the original shared contract.",
    });
    assert.equal(first.directive, "proceed");
    const second = await f.fleet.coordinate(f.project, later, {
      action: "inspect",
      plan: "Build the next feature on the shared contract.",
    });
    assert.equal(second.directive, "adhere");
    assert.equal(second.canEdit, false);
    assert.equal(second.owner.taskId, owner.id);
    assert.equal(second.owner.plan, "Preserve the original shared contract.");
    const proposed = await f.fleet.coordinate(f.project, later, {
      action: "propose",
      alternative: "Keep compatibility while adding the new behavior.",
      reason: "The additive solution serves both work items.",
    });
    assert.equal(proposed.directive, "wait");
    assert.equal(f.state.fleetConflicts.length, 0);
    const pending = await f.fleet.coordinate(f.project, owner, {
      action: "inspect",
    });
    assert.equal(pending.directive, "review-proposal");
    assert.equal(pending.canEdit, false);
    await assert.rejects(
      f.fleet.coordinate(f.project, later, {
        action: "respond",
        proposalId: proposed.proposal.id,
        decision: "accept",
        reason: "Cannot speak for owner",
      }),
      /bound owner/,
    );
    await f.fleet.coordinate(f.project, owner, {
      action: "respond",
      proposalId: proposed.proposal.id,
      decision: "accept",
      reason: "Both goals remain compatible.",
    });
    assert.equal(f.state.fleetProposals?.[0].state, "accepted");
    assert.equal(f.state.fleetConflicts.length, 0);
    await writeFile(
      join(f.root, "shared.ts"),
      "export const contract = 'agreed implementation';\n",
    );
    await f.fleet.after(f.project, owner);
    assert.equal(f.state.fleetConflicts.length, 0);
    await f.fleet.release(f.project, owner);
    const adopted = await f.fleet.coordinate(f.project, later, {
      action: "adopt",
    });
    assert.equal(adopted.directive, "proceed");
    assert.match(adopted.source.files[0].text, /agreed implementation/);
  } finally {
    await f.release();
  }
});

test("only a rejected semantic alternative creates a human decision; unrelated workers keep their path", async () => {
  const f = await fixture();
  try {
    const [owner, later, unrelated] = f.tasks;
    const proposed = await f.fleet.coordinate(f.project, later, {
      action: "propose",
      alternative: "Replace the shared public contract.",
      reason: "A replacement design better serves the second task.",
    });
    assert.equal(f.state.fleetConflicts.length, 0);
    await assert.rejects(
      f.fleet.coordinate(f.project, owner, {
        action: "respond",
        proposalId: proposed.proposal.id,
        decision: "reject",
        reason:
          "That removes required compatibility and cannot satisfy the first task.",
      }),
      FleetBlocked,
    );
    assert.equal(f.state.fleetConflicts.length, 1);
    const conflict = f.state.fleetConflicts[0];
    assert.equal(conflict.severity, "C");
    assert.match(conflict.summary, /replacement design/);
    assert.match(conflict.summary, /required compatibility/);
    assert.deepEqual(new Set(conflict.taskIds), new Set([owner.id, later.id]));
    assert.ok(f.paused.every((ids) => !ids.includes(unrelated.id)));
    assert.doesNotThrow(() => f.fleet.assertClear(unrelated, f.project));
    assert.throws(() => f.fleet.assertClear(later, f.project), FleetBlocked);
  } finally {
    await f.release();
  }
});

test("directory scopes keep Class B checkpoints and reread tracked and newly extracted source", async () => {
  const f = await fixture();
  try {
    const task = f.tasks[0];
    task.scope = ["parts/"];
    task.evidence = undefined;
    await mkdir(join(f.root, "parts"));
    await writeFile(
      join(f.root, "parts", "before.ts"),
      "export const before = 1;\n",
    );
    await git(f.root, ["add", "parts"]);
    await f.fleet.coordinate(f.project, task, {
      action: "inspect",
      plan: "Extract a helper under parts/.",
    });
    await writeFile(
      join(f.root, "parts", "after.ts"),
      "export const after = 2;\n",
    );
    const result = await f.fleet.coordinate(f.project, task, {
      action: "checkpoint",
    });
    assert.equal(result.directive, "recorded");
    assert.ok(
      task.changesRevision,
      "The actual contribution remains attributed",
    );
    const reread = await rereadFleetSource(f.project, task);
    assert.deepEqual(reread.files.map((file) => file.file).sort(), [
      "parts/after.ts",
      "parts/before.ts",
    ]);
    assert.equal(reread.truncated, false);
  } finally {
    await f.release();
  }
});

test("directory rereads preserve literal paths and report bounded coverage", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "[parts]"));
    await mkdir(join(f.root, "parts"));
    await writeFile(
      join(f.root, "parts", "unrelated.ts"),
      "Never read the glob match",
    );
    for (let i = 0; i < 23; i++)
      await writeFile(
        join(f.root, "[parts]", `helper ${i}.ts`),
        "export const value = 1;\n",
      );
    const result = await rereadFleetSource(f.project, {
      ...f.tasks[0],
      scope: ["[parts]/"],
      evidence: undefined,
    });
    assert.equal(result.files.length, 20);
    assert.equal(result.truncated, true);
    assert.ok(result.files.every((file) => file.file.startsWith("[parts]/")));
  } finally {
    await f.release();
  }
});

test("Fleet rereads a selected project alias but still rejects a source link outside its canonical root", async () => {
  const f = await fixture(),
    outside = await realpath(
      await mkdtemp(join(tmpdir(), "memcode-fleet-outside-")),
    ),
    alias = join(f.root, "selected-alias");
  try {
    await symlink(
      f.root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await rereadFleetSource(
      { ...f.project, path: alias },
      f.tasks[0],
    );
    assert.equal(result.files[0].file, "shared.ts");
    assert.match(result.files[0].text!, /first plan/);
    const measured = await rereadFleetSource(
      { ...f.project, path: alias },
      { ...f.tasks[0], scope: [join(f.root, "shared.ts")] },
    );
    assert.equal(
      measured.files[0].file,
      "shared.ts",
      "Canonical engine anchors stay inside the selected alias",
    );
    await writeFile(join(outside, "private.ts"), "Never share outside source");
    await symlink(
      outside,
      join(f.root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      rereadFleetSource(
        { ...f.project, path: alias },
        { ...f.tasks[0], scope: ["escape/"] },
      ),
      /resolves outside/,
    );
    await assert.rejects(
      rereadFleetSource(
        { ...f.project, path: alias },
        { ...f.tasks[0], scope: ["escape/private.ts"] },
      ),
      /resolves outside/,
    );
    await assert.rejects(
      rereadFleetSource(
        { ...f.project, path: alias },
        { ...f.tasks[0], scope: ["../outside.ts"] },
      ),
      /outside/,
    );
  } finally {
    await f.release();
    assert.ok(within(await realpath(tmpdir()), outside));
    await rm(outside, { recursive: true, force: true });
  }
});
