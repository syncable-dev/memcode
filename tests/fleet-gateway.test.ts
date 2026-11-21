import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startContextSession } from "../runtime/context/host";

test("the worker's Fleet tool takes a declaration and rejects a forged identity or branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-fleet-mcp-"));
  let calls = 0;
  const waitingNews = [{ type: "peer_changed", message: "MC-1 just recorded fixing src/cart.js::cartTotal." }];
  const session = await startContextSession(
    { call: async () => ({}) },
    {
      project: {
        id: "one",
        name: "One",
        description: "Fixture",
        path: root,
        branch: "epic/one",
        repoId: "one",
        analysis: "ready",
        createdAt: new Date().toISOString(),
      },
      workerId: "bound-worker",
      branch: "epic/one",
      scope: [],
    },
    join(root, "worker"),
    {
      coordination: async (input) => {
        calls++;
        return {
          workerId: "bound-worker",
          branch: "epic/one",
          directive: "proceed",
          plan: input.plan,
          symbols: input.symbols,
          kind: input.kind,
        };
      },
      runbook: async () => "1. [ ] Add the endpoint",
      news: () => waitingNews.splice(0),
    },
  );
  const client = new Client({ name: "fleet-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      resolve("scripts/context-gateway.mjs"),
      session.configPath,
    ],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ["assess", "coordinate", "find", "runbook", "understand"],
    );
    const response = await client.callTool({
      name: "coordinate",
      arguments: {
        action: "declare",
        symbols: ["src/cart.js::cartTotal"],
        kind: "fix",
        plan: "Round half up.",
      },
    });
    assert.notEqual(response.isError, true);
    const result = JSON.parse((response.content as any)[0].text);
    assert.equal(result.workerId, "bound-worker");
    assert.equal(result.branch, "epic/one");
    assert.deepEqual(result.symbols, ["src/cart.js::cartTotal"]);
    assert.equal(result.kind, "fix");
    assert.equal(result.fleetNews, undefined, "Fleet's own replies carry their news themselves");
    assert.equal(calls, 1);
    for (const old of ["inspect", "adopt", "checkpoint"]) {
      const refused = await client
        .callTool({ name: "coordinate", arguments: { action: old } })
        .catch(() => ({ isError: true }));
      assert.equal(refused.isError, true, `${old} belonged to taking turns`);
    }
    const other = await client.callTool({ name: "runbook", arguments: {} });
    const carried = JSON.parse((other.content as any)[0].text);
    assert.equal(carried.reply, "1. [ ] Add the endpoint");
    assert.match(carried.fleetNews[0].message, /MC-1 just recorded/, "whatever the worker asks next carries what peers did");
    for (const forged of [
      { workerId: "other" },
      { branch: "other" },
      { projectId: "other" },
    ]) {
      const reply = await fetch(session.endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + session.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          capability: "coordinate",
          action: "sync",
          ...forged,
        }),
      });
      assert.equal(reply.status, 400);
    }
    assert.equal(calls, 1);
  } finally {
    await client.close();
    await session.close();
  }
});
