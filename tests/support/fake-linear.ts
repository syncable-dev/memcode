import { randomUUID } from "node:crypto";

/**
 * A stand-in for Linear's API. It keeps the rules MemCode depends on, the awkward ones
 * included: it rewrites Markdown, dates every change, answers in pages, can do what it is
 * asked and lose the answer, limits requests, ends sign-ins and refuses things.
 * The queries themselves are checked against Linear's published schema elsewhere.
 */
type Json = Record<string, any>;
export interface FakeIssue {
  id: string;
  number: number;
  title: string;
  description: string;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  state: string;
  assignee: string | null;
  team: string;
  cycle: string | null;
  project: string | null;
  milestone: string | null;
  parent: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trashed: boolean;
  links: string[];
  /** When each part of it last changed. */
  changes: Record<string, string>;
}
export interface FakeComment {
  id: string;
  issue: string;
  parent: string | null;
  body: string;
  user: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What Linear makes of Markdown: other bullets, no trailing space. */
export const rewritten = (text: string) =>
  text
    .replace(/^(\s*)- /gm, "$1* ")
    .replace(/[ \t]+$/gm, "")
    .trim();

export class FakeLinear {
  team = { id: randomUUID(), key: "WEB", name: "Web" };
  otherTeam = { id: randomUUID(), key: "OPS", name: "Operations" };
  workspace = { id: randomUUID(), name: "Acme", urlKey: "acme" };
  users = {
    alex: { id: randomUUID(), name: "Alex Berg", email: "alex@example.invalid" },
    dana: { id: randomUUID(), name: "Dana Ito", email: "dana@example.invalid" },
  };
  viewer = this.users.alex;
  states: Record<string, { id: string; name: string; type: string; position: number }> = {
    triage: { id: randomUUID(), name: "Triage", type: "triage", position: 0 },
    backlog: { id: randomUUID(), name: "Backlog", type: "backlog", position: 1 },
    todo: { id: randomUUID(), name: "Todo", type: "unstarted", position: 2 },
    ready: { id: randomUUID(), name: "Ready", type: "unstarted", position: 3 },
    progress: { id: randomUUID(), name: "In Progress", type: "started", position: 4 },
    review: { id: randomUUID(), name: "In Review", type: "started", position: 5 },
    done: { id: randomUUID(), name: "Done", type: "completed", position: 6 },
    canceled: { id: randomUUID(), name: "Canceled", type: "canceled", position: 7 },
    duplicate: { id: randomUUID(), name: "Duplicate", type: "duplicate", position: 8 },
  };
  labels = new Map<string, { id: string; name: string; isGroup: boolean; group?: string }>();
  cycles = new Map<string, Json>();
  projects = new Map<string, Json>();
  issues = new Map<string, FakeIssue>();
  comments = new Map<string, FakeComment>();
  /** Every call, by operation. */
  calls: { operation: string; variables: Json }[] = [];
  /** Page size, small so that paging is always exercised. */
  pageSize = 7;
  clock = Date.parse("2026-11-25T09:00:00.000Z");
  accepts = new Set(["Bearer good", "key-good"]);
  /** Called before an operation is carried out; what it returns or throws happens instead. */
  before?: (operation: string, variables: Json) => Response | "lose" | "offline" | void;
  private count = 0;

  tick(ms = 1000): string {
    this.clock += ms;
    return new Date(this.clock).toISOString();
  }
  /** A label in a group: an issue can have one of that group. */
  label(name: string, isGroup = false, group?: string) {
    const label = { id: randomUUID(), name, isGroup, ...(group ? { group } : {}) };
    this.labels.set(label.id, label);
    return label;
  }
  project(name: string, milestones: string[] = [], type = "started") {
    const project = {
      id: randomUUID(),
      name,
      description: `About ${name}.`,
      type,
      milestones: milestones.map((title) => ({ id: randomUUID(), name: title })),
    };
    this.projects.set(project.id, project);
    return project;
  }
  cycle(name: string, startsAt: string, endsAt: string, changes: Json = {}) {
    const cycle = { id: randomUUID(), number: this.cycles.size + 1, name, startsAt, endsAt, completedAt: null, isActive: false, ...changes };
    this.cycles.set(cycle.id, cycle);
    return cycle;
  }
  issue(changes: Partial<FakeIssue> = {}): FakeIssue {
    const at = this.tick();
    const issue: FakeIssue = {
      id: randomUUID(),
      number: ++this.count,
      title: `Issue ${this.count}`,
      description: "",
      priority: 0,
      estimate: null,
      dueDate: null,
      state: this.states.todo.id,
      assignee: null,
      team: this.team.id,
      cycle: null,
      project: null,
      milestone: null,
      parent: null,
      labels: [],
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      trashed: false,
      links: [],
      changes: {},
      ...changes,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }
  /** Deleted, put back or archived: none of them changes when it was last updated. */
  bin(issue: FakeIssue, there = true): void {
    issue.trashed = there;
    issue.archivedAt = there ? this.tick() : null;
  }
  archive(issue: FakeIssue): void {
    issue.archivedAt = this.tick();
  }
  /** Someone edits it in Linear. */
  edit(issue: FakeIssue, changes: Partial<FakeIssue>): void {
    Object.assign(issue, changes, { updatedAt: this.tick() });
    for (const part of Object.keys(changes)) issue.changes[part] = issue.updatedAt;
  }
  comment(issue: FakeIssue, body: string, changes: Partial<FakeComment> = {}): FakeComment {
    const at = this.tick();
    const comment = { id: randomUUID(), issue: issue.id, parent: null, body, user: this.users.dana.id, createdAt: at, updatedAt: at, ...changes };
    this.comments.set(comment.id, comment);
    return comment;
  }
  key = (issue: FakeIssue) => `${issue.team === this.team.id ? this.team.key : this.otherTeam.key}-${issue.number}`;
  countOf = (operation: string) => this.calls.filter((call) => call.operation === operation).length;

  fetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { operationName: string; query: string; variables: Json };
    const { operationName: operation, variables } = body;
    if (!body.query.includes(operation)) throw new Error("The query does not say what it is.");
    this.calls.push({ operation, variables });
    const answer = this.before?.(operation, variables);
    if (answer === "offline") throw new TypeError("fetch failed");
    if (answer instanceof Response) return answer;
    const headers = new Headers(init?.headers as HeadersInit);
    if (!this.accepts.has(headers.get("authorization") ?? "")) return this.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, 401);
    let data: Json;
    try {
      data = this.carryOut(operation, variables);
    } catch (error) {
      return this.json({ errors: [{ message: (error as Error).message, extensions: { code: "INVALID_INPUT", userPresentableMessage: (error as Error).message } }] }, 400);
    }
    if (answer === "lose") throw new TypeError("socket hang up");
    return this.json({ data });
  };
  json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }
  limited(seconds = 60) {
    return this.json({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, 429, { "retry-after": String(seconds) });
  }

  private page(nodes: unknown[], after?: string | null) {
    const from = after ? Number(after) : 0;
    const part = nodes.slice(from, from + this.pageSize);
    const end = from + part.length;
    return { nodes: part, pageInfo: { hasNextPage: end < nodes.length, endCursor: part.length ? String(end) : null } };
  }
  private userOf(id: string | null) {
    const user = Object.values(this.users).find((item) => item.id === id);
    return user ? { ...user, displayName: user.name.toLowerCase(), active: true } : null;
  }
  private issueNode(issue: FakeIssue) {
    return {
      id: issue.id,
      identifier: this.key(issue),
      url: `https://linear.app/acme/issue/${this.key(issue)}`,
      title: issue.title,
      description: issue.description || null,
      priority: issue.priority,
      estimate: issue.estimate,
      dueDate: issue.dueDate,
      updatedAt: issue.updatedAt,
      createdAt: issue.createdAt,
      archivedAt: issue.archivedAt,
      trashed: issue.trashed || null,
      labelIds: issue.labels,
      state: { id: issue.state },
      assignee: this.userOf(issue.assignee),
      team: { id: issue.team },
      cycle: issue.cycle ? { id: issue.cycle } : null,
      project: issue.project ? { id: issue.project } : null,
      projectMilestone: issue.milestone ? { id: issue.milestone } : null,
      parent: issue.parent ? { id: issue.parent } : null,
    };
  }
  private commentNode(comment: FakeComment) {
    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      archivedAt: null,
      user: this.userOf(comment.user),
      botActor: comment.user ? null : { name: "GitHub" },
      externalUser: null,
      parent: comment.parent ? { id: comment.parent } : null,
      issue: { id: comment.issue },
    };
  }
  private stateOf = (id: string) => Object.values(this.states).find((state) => state.id === id)!;
  private matches(issue: FakeIssue, filter: Json = {}): boolean {
    const type = this.stateOf(issue.state)?.type;
    if (filter.team?.id?.eq && issue.team !== filter.team.id.eq) return false;
    if (filter.state?.type?.in && !filter.state.type.in.includes(type)) return false;
    if (filter.state?.type?.neq && type === filter.state.type.neq) return false;
    if (filter.cycle?.isActive?.eq && !(issue.cycle && this.cycles.get(issue.cycle)?.isActive)) return false;
    if (filter.updatedAt?.gt && !(issue.updatedAt > filter.updatedAt.gt)) return false;
    if (filter.archivedAt?.gt && !(issue.archivedAt && issue.archivedAt > filter.archivedAt.gt)) return false;
    if (filter.or && !filter.or.some((part: Json) => this.matches(issue, part))) return false;
    if (filter.id?.in && !filter.id.in.includes(issue.id)) return false;
    return true;
  }
  private find(id: string): FakeIssue {
    const issue = this.issues.get(id);
    if (!issue) throw new Error("Entity not found: Issue");
    return issue;
  }
  private put(issue: FakeIssue, input: Json): void {
    if ("title" in input) {
      if (!String(input.title).trim()) throw new Error("Title must not be empty");
      issue.title = String(input.title);
    }
    if ("description" in input) issue.description = rewritten(String(input.description ?? ""));
    if ("priority" in input) issue.priority = input.priority;
    if ("estimate" in input) {
      if (input.estimate !== null && ![0, 1, 2, 3, 5, 8].includes(input.estimate)) throw new Error("Estimate is not on the team's scale");
      issue.estimate = input.estimate;
    }
    if ("dueDate" in input) issue.dueDate = input.dueDate;
    if ("stateId" in input) {
      if (!this.stateOf(input.stateId)) throw new Error("Entity not found: WorkflowState");
      issue.state = input.stateId;
    }
    if ("assigneeId" in input) issue.assignee = input.assigneeId;
    if ("cycleId" in input) issue.cycle = input.cycleId;
    if ("projectId" in input) {
      if (issue.project !== input.projectId) issue.milestone = null;
      issue.project = input.projectId;
    }
    if ("projectMilestoneId" in input) {
      const project = [...this.projects.values()].find((item) => item.milestones.some((one: Json) => one.id === input.projectMilestoneId));
      if (input.projectMilestoneId && project?.id !== issue.project) throw new Error("The milestone is not in the issue's project");
      issue.milestone = input.projectMilestoneId;
    }
    if ("parentId" in input) issue.parent = input.parentId;
    if ("labelIds" in input) {
      for (const id of input.labelIds) if (!this.labels.has(id) || this.labels.get(id)!.isGroup) throw new Error("Entity not found: IssueLabel");
      const groups = input.labelIds.map((id: string) => this.labels.get(id)!.group).filter(Boolean);
      if (new Set(groups).size < groups.length)
        throw new Error("Only one label in a group can be applied to an issue.");
      issue.labels = [...input.labelIds];
    }
  }

  private carryOut(operation: string, v: Json): Json {
    switch (operation) {
      case "Viewer":
        return { viewer: this.userOf(this.viewer.id), organization: this.workspace };
      case "Teams":
        return {
          teams: this.page(
            [this.team, this.otherTeam].map((team) => ({ ...team, timezone: "Europe/Copenhagen", cyclesEnabled: true, issueEstimationType: "fibonacci", issueEstimationAllowZero: true, issueEstimationExtended: false })),
            v.after,
          ),
        };
      case "Statuses":
        return { workflowStates: { nodes: Object.values(this.states) } };
      case "People":
        return { team: { members: this.page(Object.values(this.users).map((user) => this.userOf(user.id)), v.after) } };
      case "Labels":
        return { issueLabels: this.page([...this.labels.values()].map((label) => ({ ...label, parent: null })), v.after) };
      case "Cycles":
        return { cycles: this.page([...this.cycles.values()], v.after) };
      case "Projects":
        return {
          team: {
            projects: this.page(
              [...this.projects.values()].map((project) => ({
                id: project.id,
                name: project.name,
                description: project.description,
                url: `https://linear.app/acme/project/${project.id}`,
                sortOrder: 0,
                updatedAt: "2026-11-20T00:00:00.000Z",
                archivedAt: null,
                status: { type: project.type },
                projectMilestones: { nodes: project.milestones.map((item: Json) => ({ ...item, description: "", sortOrder: 0, status: "unstarted", updatedAt: "2026-11-20T00:00:00.000Z", archivedAt: null })) },
              })),
              v.after,
            ),
          },
        };
      case "IssueIds":
      case "Issues": {
        const found = [...this.issues.values()].filter((issue) => this.matches(issue, v.filter) && (operation === "Issues" || !issue.archivedAt)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { issues: this.page(found.map((issue) => this.issueNode(issue)), v.after) };
      }
      case "History": {
        const { changes } = this.find(v.id);
        const entry = (part: string, fields: Json) => (changes[part] ? [{ createdAt: changes[part], ...fields }] : []);
        return {
          issue: {
            history: {
              nodes: [
                ...entry("title", { fromTitle: "a", toTitle: "b" }),
                ...entry("description", { updatedDescription: true }),
                ...entry("priority", { fromPriority: 0, toPriority: 1 }),
                ...entry("estimate", { fromEstimate: null, toEstimate: 1 }),
                ...entry("dueDate", { fromDueDate: null, toDueDate: "2026-11-25" }),
                ...entry("labels", { addedLabelIds: ["x"] }),
                ...entry("state", { fromState: { id: "a" }, toState: { id: "b" } }),
                ...entry("assignee", { fromAssignee: null, toAssignee: { id: "b" } }),
                ...entry("cycle", { fromCycle: null, toCycle: { id: "b" } }),
                ...entry("project", { fromProject: null, toProject: { id: "b" } }),
                ...entry("parent", { fromParent: null, toParent: { id: "b" } }),
              ],
            },
          },
        };
      }
      case "Issue":
        return { issue: this.issueNode(this.find(v.id)) };
      case "Standing": {
        const found = [...this.issues.values()].filter((issue) => this.matches(issue, v.filter));
        return { issues: this.page(found.map((issue) => ({ id: issue.id, archivedAt: issue.archivedAt, trashed: issue.trashed || null, team: { id: issue.team } })), v.after) };
      }
      case "CommentsThere":
        return { comments: this.page(v.filter.id.in.filter((id: string) => this.comments.has(id)).map((id: string) => ({ id })), v.after) };
      case "Comments": {
        const filter = v.filter ?? {};
        const found = [...this.comments.values()]
          .filter((comment) => {
            const issue = this.issues.get(comment.issue);
            if (!issue) return false;
            if (filter.issue?.team?.id?.eq && issue.team !== filter.issue.team.id.eq) return false;
            if (filter.issue?.id?.in && !filter.issue.id.in.includes(issue.id)) return false;
            return !filter.updatedAt?.gt || comment.updatedAt > filter.updatedAt.gt;
          })
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { comments: this.page(found.map((comment) => this.commentNode(comment)), v.after) };
      }
      case "UpdateIssue": {
        const issue = this.find(v.id);
        const was = { ...issue };
        // All of it or nothing.
        const next = { ...issue };
        this.put(next, v.input);
        Object.assign(issue, next);
        issue.updatedAt = this.tick();
        for (const part of Object.keys(was) as (keyof FakeIssue)[])
          if (JSON.stringify(was[part]) !== JSON.stringify(issue[part])) issue.changes[part] = issue.updatedAt;
        return { issueUpdate: { success: true, issue: this.issueNode(issue) } };
      }
      case "CreateIssue": {
        if (this.issues.has(v.input.id)) throw new Error("Entity already exists with this id");
        const issue = this.issue({ id: v.input.id, team: v.input.teamId, state: this.states.backlog.id });
        try {
          this.put(issue, v.input);
        } catch (error) {
          this.issues.delete(issue.id);
          throw error;
        }
        return { issueCreate: { success: true, issue: this.issueNode(issue) } };
      }
      case "CreateLabel": {
        if ([...this.labels.values()].some((label) => label.name.toLowerCase() === v.input.name.toLowerCase())) throw new Error("A label with this name exists");
        return { issueLabelCreate: { success: true, issueLabel: this.label(v.input.name) } };
      }
      case "CreateComment": {
        if (this.comments.has(v.input.id)) throw new Error("Entity already exists with this id");
        const comment = this.comment(this.find(v.input.issueId), rewritten(v.input.body), { id: v.input.id, user: this.viewer.id, parent: v.input.parentId ?? null });
        return { commentCreate: { success: true, comment: this.commentNode(comment) } };
      }
      case "UpdateComment": {
        const comment = this.comments.get(v.id);
        if (!comment) throw new Error("Entity not found: Comment");
        comment.body = rewritten(v.input.body);
        comment.updatedAt = this.tick();
        return { commentUpdate: { success: true, comment: this.commentNode(comment) } };
      }
      case "DeleteComment": {
        if (!this.comments.delete(v.id)) throw new Error("Entity not found: Comment");
        return { commentDelete: { success: true } };
      }
      case "LinkPullRequest":
        throw new Error("The GitHub integration is not installed");
      case "LinkUrl":
        this.find(v.issue).links.push(v.url);
        return { attachmentLinkURL: { success: true } };
      default:
        throw new Error("Unknown operation " + operation);
    }
  }
}
