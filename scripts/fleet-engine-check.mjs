// Runs MemCode's Fleet loop against the real installed Memtrace engine, with scripted
// workers instead of models. It checks that the engine behaves the way the tests' stand-in
// (tests/support/fleet-engine.ts) says it does, and measures many workers editing at once.
//
//   node --import tsx scripts/fleet-engine-check.mjs [workers...]     e.g. 10 20 50
//
// The engine runs on a throwaway repository with its own private store under the system
// temp folder. Your projects and your own Memtrace store are never opened.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FleetCoordinator } from "../runtime/fleet.ts";
import { initialState } from "../src/seed.ts";

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const root = await realpath(await mkdtemp(join(tmpdir(), "memcode-fleet-check-")));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
git("init", "--initial-branch=main");
await mkdir(join(root, "src"));
await writeFile(
  join(root, "src", "cart.js"),
  "export function cartTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\nexport function formatPrice(value) {\n  return '$' + value.toFixed(2);\n}\n",
);
await writeFile(
  join(root, "src", "checkout.js"),
  "import { cartTotal, formatPrice } from './cart.js';\nexport function checkout(items) {\n  return formatPrice(cartTotal(items));\n}\n",
);
git("add", ".");
git("-c", "user.name=Check", "-c", "user.email=check@local.invalid", "commit", "-m", "fixture");

const store = join(root, ".engine");
const transport = new StdioClientTransport({
  command: process.env.MEMTRACE_BIN ?? "memtrace",
  args: ["mcp"],
  cwd: root,
  env: {
    ...process.env,
    MEMTRACE_MEMDB_DATA_DIR: join(store, "memdb"),
    MEMTRACE_DATA_DIR: join(store, "jobs"),
    MEMTRACE_NO_WATCH_RESTORE: "1",
    MEMTRACE_SKIP_EMBED: "1",
    MEMTRACE_NO_REPLAY: "1",
    MEMTRACE_FLEET_MEDIATOR: "auto",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
const client = new Client({ name: "memcode-fleet-check", version: "1" }, { capabilities: {} });
const unwrap = (result) => {
  if (result.isError)
    throw Error(result.content?.map((item) => item.text ?? "").join("\n") || "Engine call failed");
  for (const item of [...(result.content ?? [])].reverse())
    if (item.type === "text")
      try {
        return JSON.parse(item.text);
      } catch {}
  return result;
};
const timings = new Map();
const seen = [];
const ask = async (name, args) => {
  const started = performance.now();
  const reply = unwrap(await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }));
  const took = performance.now() - started;
  timings.set(name, [...(timings.get(name) ?? []), took]);
  seen.push({ name, args, reply });
  return reply;
};
const report = [];
const check = (label, passed, detail = "") => {
  report.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

try {
  await client.connect(transport);
  const repos = await ask("list_indexed_repositories", {});
  const own = (Array.isArray(repos) ? repos : (repos.repos ?? [])).filter((repo) => repo.path === root);
  if (own.length !== 1 || (Array.isArray(repos) ? repos : repos.repos).length !== 1)
    throw Error("The engine did not open a private store for the throwaway repository. Nothing was written.");
  const repoId = own[0].repo_id;
  const status = await ask("fleet_status", {});
  console.log(`engine ${execFileSync(process.env.MEMTRACE_BIN ?? "memtrace", ["--version"]).toString().split("\n")[0].trim() || "memtrace"} · repo ${repoId} · mediator ${status.mediator_mode}`);

  let scenario = 0;
  const fleetOf = (workers) => {
    // Fresh worker names each time: the engine remembers a worker's declarations for two minutes.
    const run = ++scenario;
    const state = initialState();
    const project = { ...state.projects[0], id: "check", path: root, repoId, branch: "main", analysis: "ready", example: false };
    state.projects = [project];
    state.fleetConflicts = [];
    state.tasks = Array.from({ length: workers }, (_, index) => ({
      ...state.tasks[0],
      id: `run${run}-task-${index + 1}`,
      identifier: `MC-${index + 1}`,
      title: `Task ${index + 1}`,
      projectId: project.id,
      epicId: "goal",
      example: false,
      scope: [],
      evidence: undefined,
      messages: [],
      run: { state: "running", branch: "main", workspace: root },
    }));
    const fleet = new FleetCoordinator(
      () => state,
      { call: (_project, name, args) => ask(name, args), activateEpic: async () => {} },
      async () => {},
    );
    return { state, project, fleet, say: (task, request) => fleet.coordinate(project, task, request) };
  };
  const declare = (symbols, kind, plan) => ({ action: "declare", symbols, kind, plan });
  const lastRecord = () => [...seen].reverse().find((call) => call.name === "fleet_record_episode").reply;
  const finish = async (f) => {
    for (const task of f.state.tasks) await f.fleet.release(f.project, task).catch(() => {});
  };

  // Each scenario uses its own symbol: an engine intent lives two minutes and cannot be ended.
  {
    const f = fleetOf(2);
    const [alone] = f.state.tasks;
    for (const task of f.state.tasks) await f.fleet.before(f.project, task);
    const declared = await f.say(alone, declare(["src/alone.js::total"], "signature", "Take the currency as an argument."));
    const recorded = await f.say(alone, { action: "record" });
    const engine = lastRecord();
    check("a lone signature change is not a conflict for the worker", recorded.class === "A" && declared.canEdit === true);
    check(
      "engine today classes a lone signature change against the worker's own declaration",
      engine.conflict_class === "C",
      `engine said class ${engine.conflict_class}${engine.escalation_id ? " and opened a decision, which MemCode closed" : ""}`,
    );
    const pending = await ask("fleet_list_escalations", { repo_id: repoId });
    check("nothing is left waiting in the engine", pending.count === 0, `${pending.count} pending`);
    await finish(f);
  }
  {
    const f = fleetOf(2);
    const [first, second] = f.state.tasks;
    for (const task of f.state.tasks) await f.fleet.before(f.project, task);
    await f.say(first, declare(["src/both.js::total"], "fix", "Round half up."));
    const later = await f.say(second, declare(["src/both.js::total"], "change", "Total in the cart's currency."));
    const one = await f.say(first, { action: "record" });
    const two = await f.say(second, { action: "record" });
    check("two workers on one symbol both edit at once", later.canEdit === true && later.editingNow[0]?.task === "MC-1");
    check("both are told to re-read (class B), nobody is asked", one.class === "B" && two.class === "B" && f.state.fleetConflicts.length === 0);
    await finish(f);
  }
  {
    const f = fleetOf(2);
    const [fixer, changer] = f.state.tasks;
    for (const task of f.state.tasks) await f.fleet.before(f.project, task);
    await f.say(fixer, declare(["src/safe.js::total"], "fix", "Round half up."));
    await f.say(changer, declare(["src/safe.js::total"], "signature", "Take the currency as an argument."));
    const recorded = await f.say(changer, { action: "record" });
    const judged = recorded.class === "C"
      ? await f.say(changer, { action: "verdict", decisionId: recorded.decision.id, verdict: "reconcile", reason: "The fix applies inside the new signature." })
      : {};
    check("a signature change under a peer's edit is class C", recorded.class === "C");
    check("the engine settles the safe case without a person", judged.outcome === "settled", `outcome ${judged.outcome}, directive ${judged.directive}`);
    await finish(f);
  }
  {
    const f = fleetOf(2);
    const [renamer, changer] = f.state.tasks;
    for (const task of f.state.tasks) await f.fleet.before(f.project, task);
    await f.say(renamer, declare(["src/agree.js::total"], "rename", "Call it orderTotal."));
    await f.say(changer, declare(["src/agree.js::total"], "signature", "Take the currency as an argument."));
    const recorded = await f.say(changer, { action: "record" });
    const verdict = { action: "verdict", decisionId: recorded.decision?.id, verdict: "reconcile", reason: "Rename first, then add the argument." };
    const first = await f.say(changer, verdict);
    const second = await f.say(renamer, verdict);
    check("one verdict is not enough; two agreeing verdicts settle it", first.outcome === "waiting_for_peer" && second.outcome === "settled", `${first.outcome} then ${second.outcome}`);
    await finish(f);
  }
  {
    const f = fleetOf(2);
    const [renamer, changer] = f.state.tasks;
    for (const task of f.state.tasks) await f.fleet.before(f.project, task);
    await f.say(renamer, declare(["src/disagree.js::total"], "rename", "Call it orderTotal."));
    await f.say(changer, declare(["src/disagree.js::total"], "signature", "Take the currency as an argument."));
    const recorded = await f.say(changer, { action: "record" });
    await f.say(changer, { action: "verdict", decisionId: recorded.decision?.id, verdict: "recommend", winner: "MC-2", reason: "Callers need the currency." });
    const judged = await f.say(renamer, { action: "verdict", decisionId: recorded.decision?.id, verdict: "recommend", winner: "MC-1", reason: "The old name is wrong." });
    const [decision] = f.state.fleetConflicts;
    check("a disagreement reaches the person with both positions", judged.outcome === "needs_person" && decision?.needs === "decide" && decision.positions.length === 2, decision?.needsReason ?? "");
    check("each position says what the worker wants and its verdict", decision.positions.every((position) => position.plan && position.verdict && position.reason));
    await f.fleet.resolve(decision.id, "Keep the currency argument.", changer.id);
    const told = (await f.say(renamer, { action: "sync" })).news?.find((item) => item.type === "decided");
    check("the person's decision reaches the running worker", told?.directive === "defer");
    await finish(f);
  }
  {
    // The engine reads a peer's kind of change from any of its recent declarations, so it can
    // take a removal for a safe change and settle it alone. MemCode must still ask the person.
    const f = fleetOf(2);
    const [fixer, remover] = f.state.tasks;
    for (const task of f.state.tasks) await f.fleet.before(f.project, task);
    await f.say(remover, declare(["src/earlier.js::format"], "signature", "Take a locale."));
    await f.say(remover, { action: "record" });
    await f.say(fixer, declare(["src/removal.js::total"], "fix", "Round half up."));
    await f.say(remover, declare(["src/removal.js::total"], "remove", "Nothing calls it."));
    const recorded = await f.say(fixer, { action: "record" });
    const verdict = { action: "verdict", decisionId: recorded.decision?.id, verdict: "recommend", winner: "MC-2", reason: "Nothing calls it." };
    const first = await f.say(fixer, verdict);
    const engine = await ask("fleet_get_escalation", { escalation_id: recorded.decision?.id });
    const second = await f.say(remover, verdict);
    const [decision] = f.state.fleetConflicts;
    console.log(`INFO  after one verdict on a removal the engine's own status was ${engine.status}${engine.resolved_by ? " by " + engine.resolved_by : ""}`);
    check("a removal under a peer's edit still waits for the person", first.outcome === "waiting_for_peer" && second.outcome === "needs_person" && decision?.needs === "confirm" && decision.status === "open");
    await finish(f);
  }
  {
    // The graph part: a worker editing code that calls a symbol hears when a peer reshapes it.
    for (let waited = 0; waited < 60; waited++) {
      const [repo] = await ask("list_indexed_repositories", {});
      if (repo.index_state === "current" && repo.nodes > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const f = fleetOf(2);
    const [caller, changer] = f.state.tasks;
    for (const task of f.state.tasks) await f.fleet.before(f.project, task);
    await f.say(caller, declare(["src/checkout.js::checkout"], "change", "Show the order summary."));
    await f.say(changer, declare(["src/cart.js::cartTotal"], "signature", "Take the currency as an argument."));
    const starting = (await f.say(caller, { action: "sync" })).news?.[0];
    const recorded = await f.say(changer, { action: "record" });
    const changed = (await f.say(caller, { action: "sync" })).news?.[0];
    check(
      "a worker whose code calls a symbol hears when a peer reshapes it, from the real graph",
      starting?.type === "peer_starting" && starting.calledFrom?.includes("src/checkout.js::checkout") && changed?.type === "peer_changed" && recorded.class === "A",
      starting ? starting.message.slice(0, 150) : "the graph named no caller",
    );
    await finish(f);
  }

  for (const workers of sizes) {
    const f = fleetOf(workers);
    for (const task of f.state.tasks) await f.fleet.before(f.project, task);
    const hot = `src/routes${workers}.js::routes`;
    const before = seen.length;
    const started = performance.now();
    let waited = 0;
    const classes = {};
    for (let round = 0; round < 3; round++) {
      const declared = await Promise.all(
        f.state.tasks.map((task, index) =>
          f.say(task, declare([hot, `src/feature${workers}-${index}.js::feature${index}`], "change", `Register feature ${index}.`)),
        ),
      );
      waited += declared.filter((reply) => reply.canEdit !== true).length;
      for (const reply of await Promise.all(f.state.tasks.map((task) => f.say(task, { action: "record" }))))
        classes[reply.class] = (classes[reply.class] ?? 0) + 1;
    }
    const took = performance.now() - started;
    const calls = seen.slice(before).reduce((all, call) => ({ ...all, [call.name]: (all[call.name] ?? 0) + 1 }), {});
    const pending = await ask("fleet_list_escalations", { repo_id: repoId });
    check(
      `${workers} workers × 3 rounds on one hot symbol: nobody waits`,
      waited === 0 && f.state.fleetConflicts.length === 0 && pending.count === 0,
      `${Math.round(took)} ms in all, ${Math.round(took / (workers * 3))} ms per edit, classes ${JSON.stringify(classes)}, engine calls ${JSON.stringify(calls)}`,
    );
    await finish(f);
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
  for (const name of ["fleet_publish_intent", "fleet_record_episode", "fleet_resolve_escalation"]) {
    const values = timings.get(name) ?? [];
    if (values.length)
      console.log(`INFO  ${name}: ${values.length} calls, median ${percentile(values, 0.5).toFixed(1)} ms, p95 ${percentile(values, 0.95).toFixed(1)} ms`);
  }
} catch (error) {
  check("the check ran to the end", false, error.message);
} finally {
  await client.close().catch(() => {});
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
const failed = report.filter((item) => !item.passed);
console.log(`\n${report.length - failed.length} of ${report.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
