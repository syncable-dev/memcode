import { randomUUID } from "node:crypto";
import type { AppState, FleetConflict, Project, WorkItem } from "../src/shared";
import type { MemtraceEngine } from "./memtrace";
import { declaredIntent, touchedIdentities } from "./coordination";
import { isActive } from "../src/domain";
import { now } from "./local";
import { FleetCollaboration, overlappingScope } from "./fleet-collaboration";
import { rereadFleetSource } from "./fleet-source";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { coordinationSchema } from "./fleet-requests";
import { WorkerChangeJournal } from "./changes";

export class FleetBlocked extends Error {}
type Json = Record<string, any>;

export class FleetCoordinator {
  private leases = new Map<string, string>();
  private announced = new Set<string>();
  private changes = new WorkerChangeJournal();
  private collaboration: FleetCollaboration;
  constructor(
    private state: () => AppState,
    private engine: MemtraceEngine,
    private changed: () => Promise<void>,
    private pause: (ids: string[]) => void,
  ) {
    this.collaboration = new FleetCollaboration(state, changed, {
      reserve: (project, task) => this.reserve(project, task),
      publish: (project, task) => this.publish(project, task),
      context: (project, task) => this.context(project, task),
      assertClear: (task, project) => this.assertClear(task, project),
      disagree: (project, task, peerId, reason) =>
        this.block(
          project,
          task,
          {
            conflict_class: "C",
            summary: reason,
            taskIds: [peerId],
            conflicting_agents: ["memcode:" + peerId],
          },
          "runtime",
        ),
    });
  }
  assertClear(task: WorkItem, project: Project): void {
    const open = this.state().fleetConflicts.find(
      (item) =>
        item.projectId === project.id &&
        item.branch === task.run.branch &&
        item.status === "open" &&
        (item.severity === "C" || !!item.escalationId) &&
        (item.taskIds.includes(task.id) ||
          overlappingScope(item.scope, this.scope(task, project))),
    );
    if (open)
      throw new FleetBlocked(
        "This epic has an unresolved Fleet decision. Open Decisions before resuming work.",
      );
    const decision = [...this.state().fleetConflicts]
      .reverse()
      .find(
        (item) =>
          item.projectId === project.id &&
          item.status === "resolved" &&
          item.taskIds.includes(task.id),
      );
    if (decision?.winnerTaskId && decision.winnerTaskId !== task.id)
      throw new FleetBlocked(
        "The human decision deferred this story. Revise that decision before resuming this worker.",
      );
  }
  async before(project: Project, task: WorkItem): Promise<void> {
    if (!project.repoId || project.analysis !== "ready")
      throw new Error(
        "Connect Memtrace before launching a shared-branch Fleet worker.",
      );
    await this.repairCoordinationRecords(project);
    this.assertClear(task, project);
    const context = await this.call(project, task, "fleet_branch_context", {});
    for (const pending of context.pending_escalations ?? [])
      await this.ingest(project, pending);
    this.assertClear(task, project);
    const touched = this.scope(task, project);
    const preflight = await this.call(project, task, "fleet_preflight", {
      touched,
      intent: declaredIntent(task),
    });
    await this.inspect(project, task, preflight, "preflight");
    await this.collaboration.register(project, task);
    await this.collaboration.prepare(project, task);
    const published = await this.publish(project, task);
    await this.inspect(project, task, published, "publish");
  }
  private async reserve(project: Project, task: WorkItem): Promise<boolean> {
    if (this.leases.has(task.id)) return true;
    const lease = await this.engine.call(project, "fleet_acquire_lease", {
      repo_id: project.repoId,
      agent_id: "memcode:" + task.id,
      // Native leases identify string scopes, not branches. Namespace their
      // keys so independent epic checkouts do not block one another. Published
      // intents retain their canonical repo, original branch and source keys.
      scope: this.scope(task, project).map(
        (scope) =>
          `branch::${JSON.stringify(task.run.branch ?? project.branch)}::${scope}`,
      ),
      priority: 0,
      ttl_seconds: 120,
    });
    if (lease.state === "granted" && lease.lease_id) {
      this.leases.set(task.id, lease.lease_id);
      await this.changes.begin(project, task);
      return true;
    }
    if (lease.lease_id)
      await this.engine.call(project, "fleet_release_lease", {
        lease_id: lease.lease_id,
      });
    return false;
  }
  async context(project: Project, task: WorkItem) {
    const engine = await this.call(project, task, "fleet_branch_context", {});
    return {
      branch: task.run.branch,
      workerId: "memcode:" + task.id,
      plans: (this.state().fleetPlans ?? [])
        .filter(
          (plan) =>
            plan.projectId === project.id &&
            plan.branch === task.run.branch &&
            plan.active,
        )
        .map((plan) => ({
          taskId: plan.taskId,
          plan: plan.plan,
          publishedAt: plan.publishedAt,
          scope: plan.scope,
          adoptedFrom: plan.adoptedFrom,
        })),
      engine,
    };
  }
  async coordinate(
    project: Project,
    task: WorkItem,
    input: unknown,
    signal?: AbortSignal,
  ) {
    const request = coordinationSchema.parse(input);
    let result: any;
    if (request.action === "checkpoint") {
      this.assertClear(task, project);
      if (!this.leases.has(task.id))
        throw Error(
          "Inspect Fleet and obtain the edit reservation before recording a source edit.",
        );
      await this.after(project, task);
      result = {
        directive: "recorded",
        canEdit: false,
        requirement: "Inspect current Fleet plans before the next edit.",
      };
    } else
      result = await this.collaboration.coordinate(
        project,
        task,
        request,
        signal,
      );
    if (task.run.workspace) {
      const directory = join(
        task.run.workspace,
        ".memcode",
        "workers",
        task.id,
      );
      await mkdir(directory, { recursive: true });
      await appendFile(
        join(directory, "fleet-activity.jsonl"),
        JSON.stringify({
          at: now(),
          request: input,
          directive: result.directive,
          canEdit: result.canEdit,
          ownerTaskId: result.owner?.taskId,
          proposalId: result.proposal?.id,
        }) + "\n",
        { mode: 0o600 },
      );
    }
    task.messages.push({
      id: randomUUID(),
      role: "tool",
      at: now(),
      text:
        "Fleet · " +
        request.action +
        " · " +
        result.directive +
        "\n" +
        JSON.stringify(
          {
            request,
            directive: result.directive,
            canEdit: result.canEdit,
            ownerTaskId: result.owner?.taskId,
            adoptedFrom: result.adoptedFrom,
          },
          null,
          2,
        ),
    });
    if (task.messages.length > 250)
      task.messages.splice(1, task.messages.length - 250);
    await this.changed();
    return result;
  }
  async heartbeat(project: Project, task: WorkItem): Promise<void> {
    this.assertClear(task, project);
    const lease = this.leases.get(task.id);
    if (lease)
      await this.engine.call(project, "fleet_renew_lease", {
        lease_id: lease,
        ttl_seconds: 120,
      });
    await this.inspect(
      project,
      task,
      await this.publish(project, task),
      "publish",
    );
    await this.refresh(project);
    this.assertClear(task, project);
  }
  async after(project: Project, task: WorkItem): Promise<void> {
    if (!this.leases.has(task.id)) return;
    await this.changes.checkpoint(project, task);
    const result = await this.call(project, task, "fleet_record_episode", {
      intent: declaredIntent(task),
      touched: this.scope(task, project),
      metadata: {
        source: "memcode",
        task_id: task.id,
        epic_id: task.epicId,
        shared_branch: true,
        scope_basis: "declared_and_qualified",
        actual_diff_attribution: "worker_reservation_checkpoints",
        changes_revision: task.changesRevision,
      },
    });
    if (result.conflict_class === "B" && !result.escalation_id) {
      await rereadFleetSource(project, task);
      task.messages.push({
        id: randomUUID(),
        role: "tool",
        at: now(),
        text: "Memtrace · shared source refreshed\nClass B: current scoped source was re-read; the result remains a review candidate.",
      });
    }
    await this.inspect(project, task, result, "episode");
  }
  async release(project: Project, task: WorkItem): Promise<void> {
    try {
      if (this.leases.has(task.id)) await this.changes.release(project, task);
    } finally {
      this.collaboration.release(task);
      const lease = this.leases.get(task.id);
      this.leases.delete(task.id);
      if (lease)
        await this.engine.call(project, "fleet_release_lease", {
          lease_id: lease,
        });
      if (project.repoId && this.announced.delete(task.id))
        await this.call(project, task, "fleet_publish_intent", {
          touched: [],
          intent: "exploratory",
          assignment: "Worker stopped; no active write scope.",
        });
    }
  }
  async refresh(project: Project): Promise<void> {
    if (!project.repoId || project.analysis !== "ready") return;
    await this.repairCoordinationRecords(project);
    const result = await this.engine.call(project, "fleet_list_escalations", {
      repo_id: project.repoId,
    });
    for (const entry of result.pending ?? []) await this.ingest(project, entry);
  }
  async failure(
    project: Project,
    task: WorkItem,
    summary: string,
  ): Promise<void> {
    task.run.error = summary;
    task.messages.push({
      id: randomUUID(),
      role: "system",
      at: now(),
      text:
        summary +
        "\nThis is a coordination service problem. Shared work is preserved; it is not an agent semantic disagreement.",
    });
    await this.changed();
  }
  async resolve(
    id: string,
    resolution: string,
    winnerTaskId?: string,
  ): Promise<void> {
    const item = this.state().fleetConflicts.find((item) => item.id === id);
    if (!item) throw new Error("Fleet decision not found.");
    if (winnerTaskId && !item.taskIds.includes(winnerTaskId))
      throw new Error("Choose one of the affected story workers.");
    if (
      item.taskIds.some((id) => {
        const task = this.state().tasks.find((task) => task.id === id);
        return task && isActive(task);
      })
    )
      throw new Error(
        "Wait for the affected workers to stop before recording the decision.",
      );
    const project = this.state().projects.find(
      (project) => project.id === item.projectId,
    )!;
    if (item.escalationId)
      await this.engine.call(project, "fleet_resolve_escalation", {
        escalation_id: item.escalationId,
        resolution,
        winner: winnerTaskId ? `memcode:${winnerTaskId}` : undefined,
      });
    Object.assign(item, {
      status: "resolved",
      resolution,
      winnerTaskId,
      resolvedAt: now(),
      resolutionKind: "human",
    });
    await this.changed();
  }
  private scope(task: WorkItem, project: Project): string[] {
    const scope = touchedIdentities(task, project);
    return scope.length ? scope : [`repo::${project.repoId}`];
  }
  private call(project: Project, task: WorkItem, name: string, extra: Json) {
    return this.engine.call(project, name, {
      repo_id: project.repoId,
      branch: task.run.branch ?? project.branch,
      agent_id: `memcode:${task.id}`,
      ...extra,
    });
  }
  private publish(project: Project, task: WorkItem) {
    this.announced.add(task.id);
    return this.call(project, task, "fleet_publish_intent", {
      intent: declaredIntent(task),
      touched: this.scope(task, project),
      assignment:
        task.identifier +
        ": " +
        ((this.state().fleetPlans ?? []).find(
          (plan) => plan.taskId === task.id && plan.active,
        )?.plan ?? task.title + "\n" + task.description),
    });
  }
  private async inspect(
    project: Project,
    task: WorkItem,
    result: Json,
    source: FleetConflict["source"],
  ) {
    // Overlap and Class B are coordination inputs. Only an unresolved
    // semantic/Class C decision belongs in the human queue.
    if (result.escalation_id || result.conflict_class === "C")
      await this.block(project, task, result, source);
  }
  private async repairCoordinationRecords(project: Project) {
    let changed = false;
    for (const item of this.state().fleetConflicts) {
      if (
        item.projectId !== project.id ||
        item.status !== "open" ||
        item.severity === "C" ||
        item.escalationId
      )
        continue;
      item.status = "resolved";
      item.resolvedAt = now();
      item.resolutionKind = "coordination";
      item.resolution =
        "Reclassified as coordination or source refresh. Workers must inspect the first published plan and re-read current source before editing. No semantic disagreement was recorded.";
      changed = true;
    }
    if (changed) await this.changed();
  }
  private async block(
    project: Project,
    task: WorkItem,
    result: Json,
    source: FleetConflict["source"],
  ): Promise<never> {
    const agentIds = [
      ...new Set([
        `memcode:${task.id}`,
        ...(result.active_conflicts ?? result.conflicting_agents ?? [])
          .map((entry: any) =>
            typeof entry === "string"
              ? entry
              : (entry?.agent_id ?? entry?.intent?.agent_id),
          )
          .filter(Boolean),
      ]),
    ] as string[];
    const peers = this.state().tasks.filter(
      (other) =>
        other.projectId === project.id &&
        other.epicId === task.epicId &&
        isActive(other),
    );
    const taskIds = [
      ...new Set([
        task.id,
        ...(result.taskIds ?? []),
        ...peers
          .filter(
            (peer) =>
              agentIds.includes("memcode:" + peer.id) ||
              overlappingScope(
                this.scope(task, project),
                this.scope(peer, project),
              ),
          )
          .map((peer) => peer.id),
      ]),
    ];
    const id = result.escalation_id ?? randomUUID();
    let item = this.state().fleetConflicts.find(
      (item) =>
        (result.escalation_id && item.escalationId === result.escalation_id) ||
        (item.projectId === project.id &&
          item.branch === (task.run.branch ?? project.branch) &&
          item.status === "open" &&
          item.taskIds.some((id) => taskIds.includes(id))),
    );
    if (!item) {
      item = {
        id,
        projectId: project.id,
        epicId: task.epicId ?? undefined,
        branch: task.run.branch ?? project.branch,
        taskIds,
        agentIds,
        scope: Array.isArray(result.touched)
          ? result.touched.filter((value: unknown) => typeof value === "string")
          : this.scope(task, project),
        severity:
          result.conflict_class === "C" || result.escalation_id
            ? "C"
            : source === "runtime"
              ? "unknown"
              : "B",
        source,
        summary:
          [result.summary, result.replan_hint, result.reason].find(
            (value) => typeof value === "string",
          ) ??
          "Fleet detected overlapping work. Inspect the shared changes and decide how the affected stories should continue.",
        status: "open",
        createdAt: now(),
        escalationId: result.escalation_id,
      };
      this.state().fleetConflicts.push(item);
    } else {
      item.taskIds = [...new Set([...item.taskIds, ...taskIds])];
      if (result.conflict_class === "C" || result.escalation_id)
        item.severity = "C";
      if (result.escalation_id) item.escalationId = result.escalation_id;
    }
    await this.changed();
    this.pause(item!.taskIds);
    throw new FleetBlocked(
      "Fleet paused this epic for a human decision. Shared changes have been preserved.",
    );
  }
  private async ingest(project: Project, entry: Json): Promise<void> {
    const branch = entry.branch ?? entry.episode?.branch ?? project.branch;
    const task = this.state().tasks.find(
      (task) =>
        task.projectId === project.id &&
        (task.run.branch === branch ||
          (!!entry.epic_id && task.epicId === entry.epic_id)),
    );
    if (!task) return;
    try {
      await this.block(
        project,
        task,
        {
          ...entry,
          escalation_id: entry.escalation_id ?? entry.id,
          conflict_class: "C",
        },
        "remote",
      );
    } catch (error) {
      if (!(error instanceof FleetBlocked)) throw error;
    }
  }
}
