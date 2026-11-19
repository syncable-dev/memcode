// Explicit acceptance: real installed harnesses, disposable source, no personal board.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { findCommand, childEnv } from "../runtime/local.ts";
import { discoverHarnesses } from "../runtime/catalog.ts";
import { startHarnessSession } from "../runtime/agents/index.ts";
import type { Harness } from "../src/shared.ts";
import type { AgentEvent } from "../runtime/agents/types.ts";

const output =
  process.env.QA_CONTINUITY_OUTPUT ?? "release/native-continuity.json";
const cases = await Promise.all(
  (["codex", "claude", "cursor"] as Harness[])
    .filter(
      (harness) =>
        !process.env.QA_HARNESS || harness === process.env.QA_HARNESS,
    )
    .map(async (harness) => {
      const started = Date.now(),
        cwd = await mkdtemp(join(tmpdir(), `memcode-native-${harness}-`));
      const result: Record<string, any> = {
        harness,
        workspace: cwd,
        passed: false,
      };
      try {
        execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
        await writeFile(
          join(cwd, "answer.mjs"),
          "export function answer(){ return 0; }\n",
        );
        const command = await findCommand(harness);
        assert.ok(command);
        const [runtime] = await discoverHarnesses(true, harness);
        const model =
          runtime.models?.find((m) => m.tier === "fast") ?? runtime.models?.[0];
        const selected =
          harness === "claude" ? "sonnet" : (model?.id ?? "default");
        const tag = "MEMORY-" + randomUUID();
        const turns: Array<{ id: string; events: AgentEvent[] }> = [];
        const run = async (prompt: string, resumeSessionId?: string) => {
          const events: AgentEvent[] = [];
          const session = startHarnessSession(harness, {
            command,
            cwd,
            env: childEnv(),
            model: selected,
            effort: "medium",
            prompt,
            resumeSessionId,
            briefPath: "brief.md",
            toolArgs: [],
            permissionMode: "full-access",
            onEvent: (event) => events.push(event),
            requestInput: async () => ({ cancelled: true }),
          });
          const timer = setTimeout(() => {
            void session.stop();
          }, 240_000);
          try {
            const completed = await session.completion;
            assert.equal(completed.exitCode, 0, completed.error);
            const ids = events.filter(
              (e): e is Extract<AgentEvent, { type: "session" }> =>
                e.type === "session",
            );
            assert.equal(new Set(ids.map((e) => e.sessionId)).size, 1);
            const id = ids[0]?.sessionId;
            assert.ok(id);
            const messages = new Map<string, string>();
            for (const event of events) {
              if (event.type !== "message" || event.role !== "assistant")
                continue;
              const key = event.messageId ?? `message:${messages.size}`;
              messages.set(
                key,
                event.delta
                  ? (messages.get(key) ?? "") + event.text
                  : event.text,
              );
            }
            const answer = [...messages.values()].join("\n");
            turns.push({ id, events });
            return answer;
          } finally {
            clearTimeout(timer);
            await session.stop();
          }
        };
        const firstAnswer = await run(
          `This is a disposable coding acceptance task. Change answer.mjs so answer() returns 42. Do not modify any other file. Remember this validation tag ONLY in conversation memory: ${tag}. Do not put the tag in a file. Reply briefly when done.`,
        );
        result.firstAnswer = firstAnswer.replaceAll(tag, "[validation tag]");
        assert.match(await readFile(join(cwd, "answer.mjs"), "utf8"), /42/);
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "import assert from 'node:assert/strict';import{answer}from'./answer.mjs';assert.equal(answer(),42)",
          ],
          { cwd },
        );
        const answer = await run(
          "What validation tag did I ask you to remember? Reply with the exact tag. Do not read or edit files or run commands.",
          turns[0].id,
        );
        result.followupAnswer = answer.replaceAll(tag, "[validation tag]");
        assert.ok(
          answer.includes(tag),
          "The second turn did not recover the first turn's in-memory tag.",
        );
        assert.equal(turns[0].id, turns[1].id);
        result.providerSessionHash = createHash("sha256")
          .update(turns[0].id)
          .digest("hex");
        result.nativeSessionCount = 1;
        result.codingCheck = true;
        result.memoryCheck = true;
        result.confirmedModels = turns.flatMap((t) =>
          t.events.flatMap((e) =>
            e.type === "measurement" && e.model ? [e.model.id] : [],
          ),
        );
        result.passed = true;
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      result.elapsedMs = Date.now() - started;
      console.log(
        JSON.stringify({
          harness,
          passed: result.passed,
          error: result.error,
          elapsedMs: result.elapsedMs,
        }),
      );
      return result;
    }),
);
const receipt = {
  at: new Date().toISOString(),
  platform: process.platform,
  source: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  scope:
    "Actual native adapters with real providers and disposable coding; not a two-device or native graph test.",
  passed: cases.every((c) => c.passed),
  cases,
};
await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
if (!receipt.passed) process.exitCode = 1;
