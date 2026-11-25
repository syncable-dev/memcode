import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { FleetCoordinator } from "../runtime/fleet";
import { readWorkerChanges } from "../runtime/changes";
import { git } from "../runtime/local";
import type { WorkItem } from "../src/shared";
import { fleetEngine } from "./support/fleet-engine";

const cartTotal = "src/cart.js::cartTotal";
const formatPrice = "src/cart.js::formatPrice";
const applyDiscount = "src/discounts.js::applyDiscount";

async function goal(
  t: { after(fn: () => unknown): void },
  workers = 2,
  engineOptions: Parameters<typeof fleetEngine>[0] = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memcode-fleet-loop-")));
  await git(root, ["init", "--initial-branch=main"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "cart.js"), "export const cartTotal = 1;\nexport const formatPrice = 1;\n");
  await writeFile(join(root, "src", "discounts.js"), "export const applyDiscount = 1;\n");
  const state = initialState();
  const project = {
    ...state.projects[0],
    id: "shop",
    path: root,
    repoId: "shop",
    analysis: "ready" as const,
    example: false,
  };
  state.projects = [project];
  state.fleetConflicts = [];
  const tasks = Array.from(
    { length: workers },
    (_, index) =>
      ({
        ...state.tasks[0],
        id: "task-" + (index + 1),
        identifier: "MC-" + (index + 1),
        title: "Task " + (index + 1),
        projectId: project.id,
        epicId: "goal",
        example: false,
        scope: [],
        evidence: undefined,
        messages: [],
        run: { state: "running", branch: "main", workspace: root },
      }) as WorkItem,
  );
  state.tasks = tasks;
  const engine = fleetEngine(engineOptions);
  const fleet = new FleetCoordinator(() => state, engine.engine, async () => {});
  for (const task of tasks) await fleet.before(project, task);
  t.after(async () => {
    for (const task of tasks) await fleet.release(project, task).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    state,
    project,
    tasks,
    fleet,
    engine,
    say: (task: WorkItem, request: Record<string, unknown>) =>
      fleet.coordinate(project, task, request) as Promise<any>,
    write: (file: string, text: string) => writeFile(join(root, file), text),
  };
}
const declare = (symbols: string[], kind: string, plan: string) => ({
  action: "declare",
  symbols,
  kind,
  plan,
});
const newsFor = (reply: any) => (reply.news ?? []) as Array<Record<string, any>>;

test("two workers on different symbols edit at the same time and neither waits", async (t) => {
  const f = await goal(t);
  const [first, second] = f.tasks;
  const a = await f.say(first, declare([cartTotal], "fix", "Round half up."));
  const b = await f.say(second, declare([applyDiscount], "add", "Add percentage codes."));
  assert.equal(a.canEdit, true);
  assert.equal(b.canEdit, true);
  assert.deepEqual(b.editingNow, []);
  assert.equal((await f.say(first, { action: "record" })).class, "A");
  const recorded = await f.say(second, { action: "record" });
  assert.equal(recorded.class, "A");
  assert.equal(recorded.directive, "proceed");
  assert.equal(f.engine.counts().fleet_acquire_lease, undefined, "nothing is ever locked");
  assert.equal(f.state.fleetConflicts.length, 0);
});

test("two workers changing the same symbol both go ahead; each is told to re-read and why the other changed it", async (t) => {
  const f = await goal(t);
  const [first, second] = f.tasks;
  await f.say(first, declare([cartTotal], "fix", "Round half up."));
  const later = await f.say(second, declare([cartTotal], "change", "Total in the cart's currency."));
  assert.equal(later.canEdit, true, "the second worker does not wait for the first");
  assert.equal(later.editingNow[0].task, "MC-1");
  assert.equal(later.editingNow[0].plan, "Round half up.");
  await f.write("src/cart.js", "export const cartTotal = 2;\nexport const formatPrice = 1;\n");
  const recorded = await f.say(first, { action: "record" });
  assert.equal(recorded.class, "B");
  assert.equal(recorded.directive, "reread");
  assert.equal(recorded.because[0].task, "MC-2");
  assert.match(recorded.source.files[0].text, /cartTotal = 2/, "the reply holds the source as it is now");
  assert.equal(f.state.fleetConflicts.length, 0, "an overlap is not a decision for the person");
});

test("a worker hears at its next call what a peer changed in the symbol it is editing, and why", async (t) => {
  const f = await goal(t, 3);
  const [first, second, elsewhere] = f.tasks;
  await f.say(first, declare([cartTotal], "fix", "Round half up."));
  await f.say(second, declare([cartTotal], "change", "Total in the cart's currency."));
  await f.say(elsewhere, declare([applyDiscount], "add", "Add percentage codes."));
  await f.say(first, { action: "record" });
  const [update] = newsFor(await f.say(second, { action: "sync" }));
  assert.equal(update.type, "peer_changed");
  assert.equal(update.task, "MC-1");
  assert.equal(update.kind, "fix");
  assert.equal(update.plan, "Round half up.");
  assert.deepEqual(update.symbols, [cartTotal]);
  assert.match(update.message, /MC-1 .*cartTotal.*Round half up/);
  assert.deepEqual(newsFor(await f.say(second, { action: "sync" })), [], "told once");
  assert.deepEqual(newsFor(await f.say(elsewhere, { action: "sync" })), [], "a worker elsewhere is not disturbed");
});

test("a worker editing another symbol in the same file is told the file changed", async (t) => {
  const f = await goal(t);
  const [first, second] = f.tasks;
  await f.say(first, declare([cartTotal], "fix", "Round half up."));
  const other = await f.say(second, declare([formatPrice], "change", "Show the currency symbol."));
  assert.equal(other.sameFiles[0].task, "MC-1");
  assert.equal((await f.say(first, { action: "record" })).class, "A", "different symbols are independent");
  const [update] = newsFor(await f.say(second, { action: "sync" }));
  assert.equal(update.type, "peer_changed");
  assert.match(update.message, /src\/cart\.js/);
});

test("a worker whose code calls a symbol hears when a peer reshapes it, before and after", async (t) => {
  const f = await goal(t, 3, {
    callers: { cartTotal: [{ name: "checkout", file_path: "src/checkout.js" }] },
  });
  const [caller, changer, elsewhere] = f.tasks;
  await f.say(caller, declare(["src/checkout.js::checkout"], "change", "Show the order summary."));
  await f.say(elsewhere, declare([applyDiscount], "add", "Add percentage codes."));
  await f.say(changer, declare([cartTotal], "signature", "Take the currency as an argument."));
  const [starting] = newsFor(await f.say(caller, { action: "sync" }));
  assert.equal(starting.type, "peer_starting");
  assert.deepEqual(starting.symbols, [cartTotal]);
  assert.deepEqual(starting.calledFrom, ["src/checkout.js::checkout"]);
  assert.match(starting.message, /MC-2 .*signature.*cartTotal.*Take the currency.*src\/checkout\.js::checkout calls it/);
  assert.equal((await f.say(changer, { action: "record" })).class, "A", "calling a symbol is not editing it");
  const [changed] = newsFor(await f.say(caller, { action: "sync" }));
  assert.equal(changed.type, "peer_changed");
  assert.deepEqual(changed.calledFrom, ["src/checkout.js::checkout"]);
  assert.deepEqual(newsFor(await f.say(elsewhere, { action: "sync" })), [], "code that does not call it hears nothing");
  assert.equal(
    f.engine.calls.filter((call) => call.name === "get_impact").every((call) => call.args.direction === "upstream" && call.args.file_path === "src/cart.js"),
    true,
  );
});

test("an ordinary edit does not ask the graph who calls the symbol", async (t) => {
  const f = await goal(t);
  const [worker] = f.tasks;
  await f.say(worker, declare([cartTotal], "fix", "Round half up."));
  await f.say(worker, { action: "record" });
  assert.equal(f.engine.counts().get_impact, undefined);
});

test("a signature change under a peer's edit that Fleet can order safely is settled without the person", async (t) => {
  const f = await goal(t);
  const [fixer, changer] = f.tasks;
  await f.say(fixer, declare([cartTotal], "fix", "Round half up."));
  const declared = await f.say(changer, declare([cartTotal], "signature", "Take the currency as an argument."));
  assert.equal(declared.canEdit, true);
  assert.match(declared.warning, /MC-1/);
  const [warned] = newsFor(await f.say(fixer, { action: "sync" }));
  assert.equal(warned.type, "peer_starting");
  assert.match(warned.message, /MC-2 .*signature.*cartTotal.*Take the currency/);
  const recorded = await f.say(changer, { action: "record" });
  assert.equal(recorded.class, "C");
  assert.equal(recorded.directive, "judge");
  assert.deepEqual(
    recorded.decision.positions.map((position: any) => [position.task, position.kind, position.plan]),
    [
      ["MC-2", "signature", "Take the currency as an argument."],
      ["MC-1", "fix", "Round half up."],
    ],
  );
  const judged = await f.say(changer, {
    action: "verdict",
    decisionId: recorded.decision.id,
    verdict: "reconcile",
    reason: "The rounding fix applies unchanged inside the new signature.",
  });
  assert.equal(judged.outcome, "settled");
  assert.equal(judged.directive, "proceed");
  const [decided] = newsFor(await f.say(fixer, { action: "sync" })).filter((item) => item.type === "decided");
  assert.equal(decided.directive, "defer", "the fix is rebuilt on the new signature");
  const [decision] = f.state.fleetConflicts;
  assert.equal(decision.status, "resolved");
  assert.equal(decision.resolutionKind, "agents");
  assert.equal(decision.needs, undefined, "the person was never asked");
});

test("when both workers judge the same way, their agreement settles it", async (t) => {
  const f = await goal(t);
  const [renamer, changer] = f.tasks;
  await f.say(renamer, declare([cartTotal], "rename", "Call it orderTotal."));
  await f.say(changer, declare([cartTotal], "signature", "Take the currency as an argument."));
  const recorded = await f.say(changer, { action: "record" });
  const verdict = {
    action: "verdict",
    decisionId: recorded.decision.id,
    verdict: "reconcile",
    reason: "Rename first, then add the argument to orderTotal.",
  };
  const first = await f.say(changer, verdict);
  assert.equal(first.outcome, "waiting_for_peer");
  assert.equal(first.directive, "wait");
  const [asked] = newsFor(await f.say(renamer, { action: "sync" })).filter((item) => item.type === "judge");
  assert.equal(asked.decision.id, recorded.decision.id);
  const second = await f.say(renamer, verdict);
  assert.equal(second.outcome, "settled");
  assert.equal(second.directive, "proceed");
  assert.equal(f.state.fleetConflicts[0].resolutionKind, "agents");
});

test("when the workers disagree, the person gets the decision with what each of them wants", async (t) => {
  const f = await goal(t);
  const [renamer, changer] = f.tasks;
  await f.say(renamer, declare([cartTotal], "rename", "Call it orderTotal."));
  await f.say(changer, declare([cartTotal], "signature", "Take the currency as an argument."));
  const recorded = await f.say(changer, { action: "record" });
  await f.say(changer, {
    action: "verdict",
    decisionId: recorded.decision.id,
    verdict: "recommend",
    winner: "MC-2",
    reason: "Every caller needs the currency; the rename can follow.",
  });
  const judged = await f.say(renamer, {
    action: "verdict",
    decisionId: recorded.decision.id,
    verdict: "recommend",
    winner: "MC-1",
    reason: "The old name is already wrong in three callers.",
  });
  assert.equal(judged.outcome, "needs_person");
  assert.equal(judged.directive, "wait");
  const [decision] = f.state.fleetConflicts;
  assert.equal(decision.status, "open");
  assert.equal(decision.needs, "decide");
  assert.equal(decision.summary, "MC-2 is changing the signature of cartTotal while MC-1 is renaming it.");
  assert.deepEqual(decision.scope, [cartTotal]);
  assert.deepEqual(
    decision.positions!.map((position) => [position.taskId, position.kind, position.plan, position.verdict, position.winnerTaskId, position.reason]),
    [
      ["task-2", "signature", "Take the currency as an argument.", "recommend", "task-2", "Every caller needs the currency; the rename can follow."],
      ["task-1", "rename", "Call it orderTotal.", "recommend", "task-1", "The old name is already wrong in three callers."],
    ],
  );
});

test("a removal under a peer's edit always asks the person, with the workers' recommendation", async (t) => {
  const f = await goal(t);
  const [fixer, remover] = f.tasks;
  await f.say(fixer, declare([cartTotal], "fix", "Round half up."));
  await f.say(remover, declare([cartTotal], "remove", "Nothing calls cartTotal after the checkout rewrite."));
  const recorded = await f.say(remover, { action: "record" });
  const verdict = {
    action: "verdict",
    decisionId: recorded.decision.id,
    verdict: "recommend",
    winner: "MC-1",
    reason: "The order page still calls it.",
  };
  await f.say(remover, verdict);
  const judged = await f.say(fixer, verdict);
  assert.equal(judged.outcome, "needs_person");
  const [decision] = f.state.fleetConflicts;
  assert.equal(decision.needs, "confirm");
  assert.equal(decision.recommendedTaskId, "task-1");
});

test("a removal the engine would settle on its own still waits for the person", async (t) => {
  // The engine reads a peer's kind of change from any of its recent declarations. Here it
  // takes the remover's earlier signature change for the removal and calls the case safe.
  const f = await goal(t);
  const [fixer, remover] = f.tasks;
  await f.say(remover, declare([formatPrice], "signature", "Take a locale."));
  await f.say(remover, { action: "record" });
  await f.say(fixer, declare([cartTotal], "fix", "Round half up."));
  await f.say(remover, declare([cartTotal], "remove", "Nothing calls cartTotal after the checkout rewrite."));
  const recorded = await f.say(fixer, { action: "record" });
  const verdict = {
    action: "verdict",
    decisionId: recorded.decision.id,
    verdict: "recommend",
    winner: "MC-2",
    reason: "Nothing calls it.",
  };
  const first = await f.say(fixer, verdict);
  assert.equal(
    [...f.engine.escalations.values()].find((item) => item.escalation_id === recorded.decision.id)!.status,
    "Resolved",
    "the engine settled it by itself",
  );
  assert.equal(first.outcome, "waiting_for_peer");
  assert.equal(first.directive, "wait");
  const second = await f.say(remover, verdict);
  assert.equal(second.outcome, "needs_person");
  const [decision] = f.state.fleetConflicts;
  assert.equal(decision.status, "open");
  assert.equal(decision.needs, "confirm");
  assert.equal(decision.recommendedTaskId, "task-2");
  await f.fleet.resolve(decision.id, "Removal confirmed.", "task-2");
  assert.equal(f.state.fleetConflicts[0].resolutionKind, "human");
});

test("the person's decision reaches both workers while they run, and they carry on", async (t) => {
  const f = await goal(t);
  const [renamer, changer] = f.tasks;
  await f.say(renamer, declare([cartTotal], "rename", "Call it orderTotal."));
  await f.say(changer, declare([cartTotal], "signature", "Take the currency as an argument."));
  const recorded = await f.say(changer, { action: "record" });
  await f.say(changer, { action: "verdict", decisionId: recorded.decision.id, verdict: "ask_human", reason: "Which name do callers use?" });
  await f.say(renamer, { action: "sync" });
  await f.fleet.resolve(recorded.decision.id, "Keep the currency argument; rename afterwards.", "task-2");
  const winner = newsFor(await f.say(changer, { action: "sync" })).find((item) => item.type === "decided")!;
  const other = newsFor(await f.say(renamer, { action: "sync" })).find((item) => item.type === "decided")!;
  assert.equal(winner.directive, "proceed");
  assert.equal(other.directive, "defer");
  assert.equal(other.resolution, "Keep the currency argument; rename afterwards.");
  assert.equal(f.state.fleetConflicts[0].resolutionKind, "human");
  assert.equal((await f.say(renamer, declare([cartTotal], "rename", "Call it orderTotal."))).canEdit, true);
});

for (const countsOwnIntent of [true, false])
  test(`a worker changing a signature alone is not in conflict with itself (engine ${countsOwnIntent ? "today" : "fixed"})`, async (t) => {
    const f = await goal(t, 2, { countsOwnIntent });
    const [alone] = f.tasks;
    await f.say(alone, declare([cartTotal], "signature", "Take the currency as an argument."));
    const recorded = await f.say(alone, { action: "record" });
    assert.equal(recorded.class, "A");
    assert.equal(recorded.directive, "proceed");
    assert.equal(f.state.fleetConflicts.length, 0);
    assert.ok(
      [...f.engine.escalations.values()].every((item) => item.status === "Resolved"),
      "nothing is left waiting in the engine",
    );
  });

test("a change recorded before another worker started on the symbol is history to build on, not a conflict", async (t) => {
  const f = await goal(t);
  const [changer, fixer] = f.tasks;
  await f.say(changer, declare([cartTotal], "signature", "Take the currency as an argument."));
  await f.say(changer, { action: "record" });
  const declared = await f.say(fixer, declare([cartTotal], "fix", "Round half up."));
  assert.equal(declared.canEdit, true);
  assert.deepEqual(declared.editingNow, []);
  assert.equal(declared.changedRecently[0].task, "MC-1");
  assert.equal(declared.changedRecently[0].plan, "Take the currency as an argument.");
  const recorded = await f.say(fixer, { action: "record" });
  assert.equal(recorded.class, "A");
  assert.equal(f.state.fleetConflicts.length, 0);
});

/** One task has reshaped formatPrice and recorded it; a second task now wants a different shape. */
async function rivalShapes(t: Parameters<typeof goal>[0]) {
  const f = await goal(t);
  const [options, currency] = f.tasks;
  await f.say(options, declare([formatPrice], "signature", "Take an options object."));
  await f.say(options, { action: "record" });
  return { f, options, currency };
}
const currencyCode = declare([formatPrice], "signature", "Take a currency code.");

test("a task that wants a different shape for a symbol another task just reshaped is stopped before it edits, and the person gets both wants", async (t) => {
  const { f, options, currency } = await rivalShapes(t);
  const stopped = await f.say(
    currency,
    declare([formatPrice, applyDiscount], "signature", "Take a currency code."),
  );
  assert.equal(stopped.canEdit, false, "it must not overwrite the other task's shape");
  assert.equal(stopped.directive, "hold");
  assert.deepEqual(stopped.heldSymbols, [formatPrice]);
  const [decision] = f.state.fleetConflicts;
  assert.equal(stopped.decision.id, decision.id);
  assert.equal(decision.status, "open");
  assert.equal(decision.needs, "decide");
  assert.deepEqual(decision.scope, [formatPrice]);
  assert.equal(
    decision.summary,
    "MC-2 is changing the signature of formatPrice while MC-1 is changing the signature of it.",
  );
  assert.deepEqual(
    decision.positions!.map((position) => [position.taskId, position.kind, position.plan]),
    [
      ["task-2", "signature", "Take a currency code."],
      ["task-1", "signature", "Take an options object."],
    ],
  );
  const heard = newsFor(await f.say(options, { action: "sync" })).find((item) => item.type === "judge");
  assert.equal(heard?.decision.id, decision.id, "the first task hears its shape is contested");
  assert.equal(
    (await f.say(currency, declare([applyDiscount], "fix", "Round half up."))).canEdit,
    true,
    "its other work carries on",
  );
});

test("a second shape that is edited in anyway is still caught when it is recorded", async (t) => {
  const { f, currency } = await rivalShapes(t);
  const allowed = await f.say(currency, declare([formatPrice], "change", "Support more currencies."));
  assert.equal(allowed.canEdit, true, "an ordinary change builds on the new shape");
  const recorded = await f.say(currency, { action: "record", kind: "signature", symbols: [formatPrice] });
  assert.equal(recorded.class, "C");
  assert.equal(recorded.directive, "judge");
  assert.deepEqual(
    f.state.fleetConflicts[0].positions!.map((position) => position.taskId),
    ["task-2", "task-1"],
  );
});

test("once the person has chosen between two shapes, the chosen task reshapes the symbol", async (t) => {
  const { f, options, currency } = await rivalShapes(t);
  const stopped = await f.say(currency, currencyCode);
  await f.fleet.resolve(stopped.decision.id, "Use the currency code.", "task-2");
  const decided = (task: WorkItem) =>
    f.say(task, { action: "sync" }).then((reply) => newsFor(reply).find((item) => item.type === "decided")!);
  assert.equal((await decided(currency)).directive, "proceed");
  assert.equal((await decided(options)).directive, "defer");
  assert.equal((await f.say(currency, currencyCode)).canEdit, true);
  assert.equal((await f.say(currency, { action: "record" })).class, "A");
  assert.equal(f.state.fleetConflicts.filter((item) => item.status === "open").length, 0);
});

test("the file that exports what two workers reshape is nobody's signature", async (t) => {
  const f = await goal(t, 3);
  const [first, second, third] = f.tasks;
  // Each names the file it exports from in the same group, so it comes as a signature too.
  await f.say(first, declare([cartTotal, "src/index.js"], "signature", "Take the tax rate."));
  const joined = await f.say(second, declare(["src/index.js", "src/cart.js::currencies"], "add", "List currencies."));
  assert.equal(joined.canEdit, true, "nobody waits for an export list");
  assert.equal((await f.say(first, { action: "record" })).class, "B");
  assert.equal((await f.say(second, { action: "record" })).class, "B");
  const later = await f.say(third, declare([applyDiscount, "src/index.js"], "signature", "Take a code."));
  assert.equal(later.canEdit, true, "two reshapings that share only the export list");
  assert.equal((await f.say(third, { action: "record" })).class, "A");
  assert.equal(f.state.fleetConflicts.length, 0);
});

test("removing a whole file under someone's edit is still a disagreement", async (t) => {
  const f = await goal(t);
  const [remover, editor] = f.tasks;
  await f.say(editor, declare(["src/discounts.js"], "change", "Rename the codes."));
  await f.say(remover, declare(["src/discounts.js"], "remove", "Discounts are gone."));
  assert.equal((await f.say(remover, { action: "record" })).class, "C");
});

test("what was settled between two tasks is not asked again, also when a third was in an earlier disagreement", async (t) => {
  const f = await goal(t, 3);
  const [options, currency, other] = f.tasks;
  await f.say(options, declare([formatPrice], "signature", "Take an options object."));
  await f.say(options, { action: "record" });
  // The first task's shape was already part of a disagreement with someone else.
  const earlier = await f.say(other, declare([formatPrice], "signature", "Take a locale."));
  await f.fleet.resolve(earlier.decision.id, "Options stand.", "task-1");
  const stopped = await f.say(currency, declare([formatPrice], "signature", "Take a currency code."));
  assert.equal(stopped.canEdit, false, "a new pair has its own disagreement");
  await f.fleet.resolve(stopped.decision.id, "The currency code.", "task-2");
  assert.equal((await f.say(currency, declare([formatPrice], "signature", "Take a currency code."))).canEdit, true);
  assert.equal((await f.say(currency, { action: "record" })).class, "A");
  // The other task rebuilds on it, and the one that stands touches it again.
  assert.equal((await f.say(options, declare([formatPrice], "signature", "Options that hold the code."))).canEdit, true);
  await f.say(options, { action: "record" });
  assert.equal((await f.say(currency, declare([formatPrice], "signature", "Name the code."))).canEdit, true);
  assert.equal(f.state.fleetConflicts.filter((item) => item.status === "open").length, 0);
  assert.equal(f.state.fleetConflicts.length, 2);
});

test("an intent Fleet still holds from an earlier, settled edit does not bring the person in", async (t) => {
  const f = await goal(t, 3);
  const [tax, coupon, history] = f.tasks;
  await f.say(tax, declare([cartTotal], "signature", "Take the tax rate."));
  await f.say(tax, { action: "record" });
  const stopped = await f.say(coupon, declare([cartTotal], "signature", "Take a coupon."));
  await f.fleet.resolve(stopped.decision.id, "Tax first, then the coupon.", "task-1");
  // The tax worker is done. Fleet goes on holding what it announced for two minutes.
  tax.run.state = "finished";
  await f.say(history, declare([cartTotal], "change", "Keep the lines."));
  await f.say(coupon, declare([cartTotal], "signature", "Take a coupon after the tax rate."));
  const recorded = await f.say(coupon, { action: "record" });
  assert.equal(recorded.class, "C");
  const judged = await f.say(coupon, {
    action: "verdict",
    decisionId: recorded.decision.id,
    verdict: "reconcile",
    reason: "Keeping the lines fits inside.",
  });
  assert.equal(judged.outcome, "settled", "a signature change over an ordinary edit");
  const decision = f.state.fleetConflicts.at(-1)!;
  assert.equal(decision.resolutionKind, "agents");
  assert.equal(decision.needs, undefined);
  assert.equal(f.engine.counts().fleet_resolve_escalation! >= 1, true, "Fleet's own record is closed too");
});

test("a shape the person has already accepted is history to build on, not a disagreement", async (t) => {
  const { f, options, currency } = await rivalShapes(t);
  options.run.state = "finished";
  options.stage = "done";
  assert.equal((await f.say(currency, currencyCode)).canEdit, true);
  assert.equal((await f.say(currency, { action: "record" })).class, "A");
  assert.equal(f.state.fleetConflicts.length, 0);
});

test("while a peer is changing a symbol's signature, another worker holds that symbol and is told when it is free", async (t) => {
  const f = await goal(t);
  const [changer, fixer] = f.tasks;
  await f.say(changer, declare([cartTotal], "signature", "Take the currency as an argument."));
  const held = await f.say(fixer, declare([cartTotal, applyDiscount], "fix", "Round half up."));
  assert.equal(held.canEdit, false);
  assert.equal(held.directive, "hold");
  assert.deepEqual(held.heldSymbols, [cartTotal]);
  assert.equal(held.heldBy.task, "MC-1");
  assert.equal((await f.say(fixer, declare([applyDiscount], "fix", "Round half up."))).canEdit, true, "other work carries on");
  const waiting = f.say(fixer, { action: "sync", waitMs: 5000 });
  await f.say(changer, { action: "record" });
  const started = Date.now();
  const woken = await waiting;
  assert.ok(Date.now() - started < 1000, "told as soon as the change is recorded");
  assert.equal(newsFor(woken)[0].type, "peer_changed");
  await f.say(fixer, { action: "record" });
  assert.equal((await f.say(fixer, declare([cartTotal], "fix", "Round half up."))).canEdit, true);
});

test("a pending decision holds only its contested symbol", async (t) => {
  const f = await goal(t, 3);
  const [renamer, changer, bystander] = f.tasks;
  await f.say(renamer, declare([cartTotal], "rename", "Call it orderTotal."));
  await f.say(changer, declare([cartTotal], "signature", "Take the currency as an argument."));
  await f.say(changer, { action: "record" });
  const blocked = await f.say(bystander, declare([cartTotal], "fix", "Round half up."));
  assert.equal(blocked.canEdit, false);
  assert.equal(blocked.directive, "hold");
  assert.deepEqual(blocked.heldSymbols, [cartTotal]);
  assert.equal(blocked.decision.positions.length, 2);
  assert.equal((await f.say(bystander, declare([applyDiscount], "add", "Add percentage codes."))).canEdit, true);
  assert.equal((await f.say(changer, declare([formatPrice], "change", "Show the currency symbol."))).canEdit, true);
});

test("a worker that forgets to record still has its edits recorded, and its peers are told", async (t) => {
  const f = await goal(t);
  const [forgetful, peer] = f.tasks;
  await f.say(forgetful, declare([cartTotal], "fix", "Round half up."));
  await f.say(peer, declare([cartTotal], "change", "Total in the cart's currency."));
  await f.write("src/cart.js", "export const cartTotal = 2;\nexport const formatPrice = 1;\n");
  await f.say(forgetful, declare([applyDiscount], "add", "Add percentage codes."));
  assert.equal((await readWorkerChanges(forgetful)).checkpoints.length, 1);
  assert.equal(newsFor(await f.say(peer, { action: "sync" }))[0].task, "MC-1");
  await f.write("src/discounts.js", "export const applyDiscount = 2;\n");
  await f.fleet.after(f.project, forgetful);
  assert.equal((await readWorkerChanges(forgetful)).checkpoints.length, 2, "the turn's end records what is left");
});

test("each task's record holds its own edits when two workers share a file", async (t) => {
  const f = await goal(t);
  const [first, second] = f.tasks;
  await f.say(first, declare([cartTotal], "fix", "Round half up."));
  await f.say(second, declare([formatPrice], "change", "Show the currency symbol."));
  await f.write("src/cart.js", "export const cartTotal = 2;\nexport const formatPrice = 1;\n");
  await f.say(first, { action: "record" });
  await f.write("src/cart.js", "export const cartTotal = 2;\nexport const formatPrice = 2;\n");
  await f.say(second, { action: "record" });
  const lines = async (task: WorkItem) =>
    (await readWorkerChanges(task)).checkpoints.flatMap((checkpoint) =>
      checkpoint.files.flatMap((file) =>
        file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add").map((line) => line.text)),
      ),
    );
  assert.deepEqual(await lines(first), ["export const cartTotal = 2;"]);
  assert.deepEqual(await lines(second), ["export const formatPrice = 2;"]);
  assert.deepEqual((await readWorkerChanges(first)).checkpoints[0].sharedWith, ["task-2"]);
});

test("a worker must say which symbols and what kind of change before it edits", async (t) => {
  const f = await goal(t);
  const [worker] = f.tasks;
  await assert.rejects(f.say(worker, { action: "declare", kind: "fix" }), /symbols/);
  await assert.rejects(f.say(worker, { action: "declare", symbols: [cartTotal] }), /kind/);
  await assert.rejects(f.say(worker, { action: "record" }), /[Dd]eclare/);
  await assert.rejects(f.say(worker, declare(["cartTotal"], "fix", "Round half up.")), /file::cartTotal/);
});

for (const workers of [10, 20, 50])
  test(`${workers} workers editing at once, all touching one hot symbol, never wait for each other`, async (t) => {
    const f = await goal(t, workers);
    const hot = "src/routes.js::routes";
    const started = Date.now();
    const rounds = 3;
    for (let round = 0; round < rounds; round++) {
      const declared = await Promise.all(
        f.tasks.map((task, index) =>
          f.say(task, declare([hot, `src/feature${index}.js::feature${index}`], "change", `Register feature ${index}.`)),
        ),
      );
      assert.ok(declared.every((reply) => reply.canEdit === true));
      const recorded = await Promise.all(f.tasks.map((task) => f.say(task, { action: "record" })));
      assert.ok(recorded.every((reply) => reply.class === "B" || reply.class === "A"));
    }
    const counts = f.engine.counts();
    const edits = workers * rounds;
    assert.equal(counts.fleet_acquire_lease, undefined);
    assert.equal(f.state.fleetConflicts.length, 0);
    assert.equal(counts.fleet_publish_intent, edits, "one declaration to the engine per group of edits");
    assert.equal(counts.fleet_record_episode, edits, "one record to the engine per group of edits");
    t.diagnostic(`${workers} workers × ${rounds} rounds: ${Date.now() - started} ms, engine calls ${JSON.stringify(counts)}`);
  });
