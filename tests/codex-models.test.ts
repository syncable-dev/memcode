import assert from "node:assert/strict";
import test from "node:test";
import { codexDefaultModel } from "../src/shared";
import { initialState } from "../src/seed";
import { planRoute } from "../runtime/router";
import { readCodexCatalog, recordCodexModelFailure, selectCodexModel } from "../runtime/agents/codex-models";

const command = { command: "fixture-codex", prefix: [] };
const query = (id: string) => readCodexCatalog(command, {}, async (method, params) => {
  if (method === "account/read") return { account: { type: "chatgpt", id } };
  assert.equal(method, "model/list");
  assert.equal(params.includeHidden, false);
  return params.cursor
    ? { data: [{ model: "gpt-test-sol" }, { model: "gpt-test-terra", isDefault: true }] }
    : { data: [{ model: "gpt-test-sol" }, { model: "hidden", hidden: true }], nextCursor: "next" };
});

test("native model pages exclude hidden and duplicate entries, preserve account defaults and measured tiers", async () => {
  const catalog = await query("normal");
  assert.deepEqual(catalog.models.map(model => model.id), ["gpt-test-sol", "gpt-test-terra"]);
  assert.equal(selectCodexModel(catalog, "stale", true, "frontier"), "gpt-test-sol");
  assert.equal(selectCodexModel(catalog, "", true), "gpt-test-terra");
  assert.throws(() => selectCodexModel(catalog, "stale", false), /cannot confirm access/);
});

test("a provider denial suppresses only the rejected model and authenticated account", async () => {
  const first = await query("denied");
  assert.equal(recordCodexModelFailure(first, "gpt-test-sol", Error("insufficient_quota")), false);
  assert.equal(recordCodexModelFailure(first, "gpt-test-sol", {code:"model_not_found"}), true);
  assert.equal((await query("denied")).models.length, 1);
  assert.equal((await query("other")).models.length, 2);
  assert.equal(recordCodexModelFailure(first, "gpt-test-terra", Error("The model is not supported when using Codex with a ChatGPT account.")), true);
  const exhausted = await query("denied");
  assert.equal(exhausted.allModelsDenied, true);
  assert.throws(() => selectCodexModel(exhausted, "", true), /rejected every/);
});

test("an unavailable catalog delegates automatic choices to native defaults and rejects unverified pins", async () => {
  const offline = await readCodexCatalog(command, {}, async () => { throw Error("offline"); });
  assert.equal(selectCodexModel(offline, codexDefaultModel, true), "");
  assert.throws(() => selectCodexModel(offline, "old", false), /cannot confirm access/);
});

test("current Astra, Sol and 6.1 account models remain selectable and explicit refresh retires an old denial", async () => {
  const request = async (method: string) => method === "account/read" ? {account:{type:"chatgpt",id:"new-models"}} :
    {data:["gpt-6.2-astra","gpt-6.2-sol","gpt-6.1-sol","gpt-6.1-terra","gpt-6-astra","gpt-5.6-sol"].map(model=>({model,displayName:model}))};
  const catalog=await readCodexCatalog(command,{},request);
  assert.equal(selectCodexModel(catalog,"gpt-6.2-astra",false),"gpt-6.2-astra");
  assert.equal(selectCodexModel(catalog,"gpt-6.1-sol",false),"gpt-6.1-sol");
  recordCodexModelFailure(catalog,"gpt-6.1-sol",{code:"model_not_found"});
  assert.ok(!(await readCodexCatalog(command,{},request)).models.some(m=>m.id==="gpt-6.1-sol"));
  assert.ok((await readCodexCatalog(command,{},request,true)).models.some(m=>m.id==="gpt-6.1-sol"));
});

test("automatic routing respects authenticated denials, falls back across harnesses, and preserves account isolation", async () => {
  const state = initialState();
  const task = { ...state.tasks[0], kind: "test" as const, assignment: "auto" as const };
  const runtime = async (account: string) => ({
    id: "codex" as const, name: "Codex", path: "fixture", available: true, ...await query(account),
  });
  const initial = await runtime("route-a");
  const initialModel = planRoute(task, undefined, [initial], state.settings).model;
  assert.equal(recordCodexModelFailure(initial, initialModel, { code: "model_not_found" }), true);
  const reduced = await runtime("route-a");
  const alternative = planRoute(task, undefined, [reduced], state.settings).model;
  assert.notEqual(alternative, initialModel);
  assert.equal(planRoute(task, undefined, [await runtime("route-b")], state.settings).model, initialModel);
  assert.throws(() => planRoute({ ...task, harness: "codex", modelOverride: initialModel }, undefined, [reduced], state.settings), /cannot confirm access/);
  recordCodexModelFailure(reduced, alternative, { code: "model_not_found" });
  const claude = { id: "claude" as const, name: "Claude", path: "fixture", available: true,
    models: [{ id: "sonnet", label: "Sonnet", source: "cli" as const, tier: "balanced" as const }] };
  assert.equal(planRoute(task, undefined, [await runtime("route-a"), claude], state.settings).harness, "claude");
});
