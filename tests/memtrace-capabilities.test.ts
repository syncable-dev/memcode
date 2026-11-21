import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeCheckoutCapabilities } from "../runtime/memtrace-capabilities";
import { MemtraceEngine } from "../runtime/memtrace";

const supported = { protocol_version: 1 as const, owned_worktree_v1: true, checkout_modes: ["owned-worktree-v1"] };
async function executable(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "memcode-capabilities-"));
  const script = join(directory, "engine.cjs");
  await writeFile(script, body);
  return { command: process.execPath, prefix: [script] };
}

test("capabilities use a bounded stateless process with exact arguments", async () => {
  const command = await executable(`if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['capabilities','--json']))process.exit(7);console.log(${JSON.stringify(JSON.stringify(supported))});`);
  assert.deepEqual(await probeCheckoutCapabilities(command), supported);
});

test("only an explicit older CLI command permits MCP capability fallback", async () => {
  assert.equal(await probeCheckoutCapabilities(await executable("console.error('Unknown command: capabilities');process.exit(2);")), null);
  await assert.rejects(probeCheckoutCapabilities(await executable("console.error('store is closing');process.exit(1);")), /could not verify goal isolation/);
  await assert.rejects(probeCheckoutCapabilities(await executable("console.log('{}');")), /did not provide valid checkout capabilities/);
  await assert.rejects(probeCheckoutCapabilities(await executable("console.log('not JSON');")), /invalid JSON/);
});

test("a stalled capability process cannot hang worker preparation or select legacy mode", async () => {
  await assert.rejects(probeCheckoutCapabilities(await executable("setInterval(()=>{},1000);"), 150), /could not verify goal isolation/);
});

test("supported epic startup does not connect to a busy primary history graph", async () => {
  let graphCalls = 0;
  const engine = new MemtraceEngine(() => "the-selected-engine", { checkoutCapabilities: async (path) => { assert.equal(path, "the-selected-engine"); return supported; } });
  engine.call = async () => { graphCalls++; throw Error("primary history graph is busy"); };
  assert.equal(await engine.ownedWorktreeSupport({ id: "primary" } as any), true);
  assert.equal(graphCalls, 0);
});
