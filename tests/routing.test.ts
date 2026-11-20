import { test } from "node:test";
import assert from "node:assert/strict";
import { planRoute, qualifyTier, routingInputs } from "../runtime/router.ts";
import { cursorCatalog } from "../src/cursor-models.ts";
import { initialState } from "../src/seed.ts";
import type { Evidence, HarnessRuntime } from "../src/shared.ts";

export const measured: Evidence = {
  state: "measured",
  symbols: [
    {
      name: "render",
      file: "src/components/View.tsx",
      line: 1,
      cognitive: 4,
      cyclomatic: 3,
      nesting: 2,
      metricSource: "ast",
    },
  ],
  affected: 2,
  affectedProcesses: 1,
  incomplete: false,
  note: "Test fixture, not a production measurement",
  measuredAt: "2026-11-14T00:00:00Z",
};
export const catalog: HarnessRuntime[] = ["codex", "claude", "cursor"].map(
  (id) => ({
    id: id as HarnessRuntime["id"],
    name: id,
    available: true,
    path: "fixture",
    models: (["fast", "balanced", "frontier", "extreme"] as const).map(
      (tier) => ({ id: `${id}-${tier}`, label: tier, tier, source: "alias" }),
    ),
  }),
);

test("each envelope admits its exact boundary and escalates above it", () => {
  const base = {
    ...routingInputs(measured),
    cognitive: 15,
    cyclomatic: 12,
    nesting: 3,
    affected: 8,
    processes: 1,
    moduleRoots: 1,
  };
  assert.equal(qualifyTier(base), "fast");
  assert.equal(qualifyTier({ ...base, cognitive: 16 }), "balanced");
  assert.equal(
    qualifyTier({
      ...base,
      cognitive: 90,
      cyclomatic: 75,
      nesting: 5,
      affected: 50,
      processes: 6,
    }),
    "balanced",
  );
  assert.equal(qualifyTier({ ...base, cognitive: 91 }), "frontier");
  assert.equal(
    qualifyTier({
      ...base,
      cognitive: 300,
      cyclomatic: 180,
      nesting: 9,
      affected: 150,
      processes: 14,
      moduleRoots: 2,
    }),
    "frontier",
  );
  assert.equal(qualifyTier({ ...base, affected: 151 }), "extreme");
});
test("unknown scope and estimated metrics never qualify for the fast tier", () => {
  assert.equal(qualifyTier(routingInputs()), "balanced");
  const estimated = {
    ...measured,
    symbols: measured.symbols.map((symbol) => ({
      ...symbol,
      metricSource: "estimated" as const,
    })),
  };
  assert.equal(routingInputs(estimated).cognitive, null);
  assert.equal(qualifyTier(routingInputs(estimated)), "balanced");
  assert.equal(
    qualifyTier({ ...routingInputs(measured), incomplete: true }),
    "balanced",
  );
});
test("automatic UI work receives a concrete Cursor model and effort", () => {
  const state = initialState(),
    task = {
      ...state.tasks[0],
      assignment: "auto" as const,
      scope: ["src/components/View.tsx"],
    };
  const route = planRoute(task, measured, catalog, state.settings);
  assert.equal(route.harness, "cursor");
  assert.equal(route.model, "cursor-fast");
  assert.equal(route.effort, "low");
  assert.equal(route.mode, "automatic");
});
test("unavailable catalogs produce an actionable failure rather than a fabricated route", () => {
  const state = initialState();
  assert.throws(
    () =>
      planRoute(
        { ...state.tasks[0], assignment: "auto" },
        measured,
        [],
        state.settings,
      ),
    /No eligible connected worker/,
  );
});
test("Cursor routing uses live session variants for automatic routes and validates saved overrides", () => {
  const state = initialState();
  const task = { ...state.tasks[0], assignment: "manual" as const, harness: "cursor" as const };
  const grok = "grok-4.7[context=256k,reasoning_effort=high,fast=true]";
  const offered = cursorCatalog({models:{availableModels:[{modelId:"other",name:"Other"},{modelId:grok,name:"Grok 4.7"}]}});
  const runtimes = [{...catalog[2], models: offered}];
  assert.equal(planRoute(task, undefined, runtimes, state.settings).model, grok);
  assert.equal(planRoute({...task,modelOverride:"grok-4.7-high"}, measured, runtimes, state.settings).model, grok);
  assert.throws(() => planRoute({...task,modelOverride:"grok-4.7-xhigh"}, measured, runtimes, state.settings), /Worker assignment/);
  assert.equal(planRoute({...task,modelOverride:"other"}, measured, runtimes, state.settings).model, "other");
});
test("local inference requires an explicit installed model name", () => {
  const state = initialState();
  assert.throws(
    () =>
      planRoute(state.tasks[0], measured, catalog, {
        ...state.settings,
        localModel: true,
        model: "",
      }),
    /Ollama model name/,
  );
});

test("empty remote catalogs use the provider default while explicit pins must be available", () => {
  const state = initialState();
  for (const id of ["claude", "codex", "cursor"] as const) {
    const runtime = { ...catalog.find(runtime => runtime.id === id)!, models: [] };
    const task = { ...state.tasks[0], harness: id, assignment: "manual" as const };
    const defaults = { claude: "default", codex: "Codex default", cursor: "Cursor default" };
    assert.equal(planRoute(task, measured, [runtime], state.settings).model, defaults[id]);
    assert.throws(() => planRoute({ ...task, modelOverride: "old-id" }, measured, [runtime], state.settings), /cannot confirm|no longer offers/);
  }
  const local = planRoute(state.tasks[0], measured, [catalog[0]], { ...state.settings, model: "local-ollama", localModel: true });
  assert.equal(local.model, "local-ollama");
});

test("Smart auto routes only to a connected harness with native automatic review", () => {
  const state = initialState(),
    task = {
      ...state.tasks[0],
      assignment: "auto" as const,
      permissionMode: "auto" as const,
      scope: ["src/components/View.tsx"],
    };
  const route = planRoute(task, measured, catalog, state.settings);
  assert.equal(route.harness, "codex");
  assert.throws(
    () =>
      planRoute(
        { ...task, assignment: "manual", harness: "cursor" },
        measured,
        catalog,
        state.settings,
      ),
    /ACP connection does not support/,
  );
  assert.throws(
    () =>
      planRoute(
        task,
        measured,
        catalog.filter((r) => r.id === "cursor"),
        state.settings,
      ),
    /supports Smart auto/,
  );
  assert.equal(
    planRoute(
      { ...task, permissionMode: "full-access" },
      measured,
      catalog,
      state.settings,
    ).harness,
    "cursor",
  );
});
