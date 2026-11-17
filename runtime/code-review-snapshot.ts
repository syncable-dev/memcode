import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { WorkItem } from "../src/shared";
import type { StoryReviewRun } from "../src/code-review";
import { readWorkerChanges } from "./changes";
import { checkSourceBinding } from "./verification";
import { git, within } from "./local";
import {
  projectStoryContribution,
  projectStorySegments,
} from "./code-review-projection";

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hash = /^[a-f0-9]{64}$/;
async function boundedContent(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 2_000_000)
      throw Error("A review file exceeds the bounded snapshot size.");
    const data = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < data.length) {
      const result = await file.read(data, size, data.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await file.stat();
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error("A review file changed while its content was captured.");
    return data.subarray(0, size);
  } finally {
    await file.close();
  }
}
const safePath = (value: string) =>
  value.length > 0 &&
  value.length < 2000 &&
  !/[\x00-\x1f\\]/.test(value) &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/.test(value) &&
  !value
    .split("/")
    .some(
      (part) =>
        part === ".." ||
        part === ".git" ||
        part === ".memcode" ||
        part === "node_modules",
    );

export interface StoryReviewCapture {
  snapshot: StoryReviewRun["snapshot"];
  patch: string;
  baseFiles: Record<string, string>;
  implementationRunIds: string[];
  limitations: string[];
  sourceBinding: string | null;
}

/** Compose only the story's own reservation edits. Never substitute the epic diff. */
export async function captureStoryReview(
  task: WorkItem,
): Promise<StoryReviewCapture> {
  if (!task.run.workspace)
    throw Error("This story has no execution workspace to review.");
  const root = await realpath(task.run.workspace);
  const branch = await git(root, ["branch", "--show-current"]);
  if (!branch || (task.run.branch && branch !== task.run.branch))
    throw Error(
      "The story workspace changed branch. Restore its epic branch before reviewing.",
    );
  const sourceBinding = await checkSourceBinding(root);
  const changes = await readWorkerChanges(task);
  const blobs = resolve(
    root,
    ".memcode",
    "workers",
    task.id,
    "changes",
    "blobs",
  );
  if (!within(root, blobs))
    throw Error("The change journal resolves outside this project.");
  const files = new Map<
    string,
    {
      beforeHash?: string;
      afterHash?: string;
      binary: boolean;
      attribution: "reservation" | "legacy" | "discontinuous";
      allReservations: boolean;
      segments: Array<{ beforeHash?: string; afterHash?: string }>;
    }
  >();
  const limitations = new Set<string>();
  if (!sourceBinding)
    limitations.add(
      "The full source snapshot could not be verified within the capture limits.",
    );
  for (const checkpoint of changes.checkpoints) {
    if (checkpoint.taskId !== task.id || checkpoint.branch !== branch) {
      limitations.add(
        "Some earlier checkpoints belong to another execution branch and were excluded.",
      );
      continue;
    }
    for (const file of checkpoint.files) {
      if (
        !safePath(file.path) ||
        (file.beforeHash && !hash.test(file.beforeHash)) ||
        (file.afterHash && !hash.test(file.afterHash))
      )
        throw Error(
          "The story change journal contains an invalid file binding.",
        );
      const previous = files.get(file.path);
      const continuous = !previous || previous.afterHash === file.beforeHash;
      files.set(file.path, {
        beforeHash: previous ? previous.beforeHash : file.beforeHash,
        afterHash: file.afterHash,
        binary: (previous?.binary ?? false) || file.binary,
        allReservations:
          (previous?.allReservations ?? true) &&
          checkpoint.basis === "fleet-reservation",
        // Retain one overflow sentinel without quadratic/unbounded journal copies.
        segments:
          (previous?.segments.length ?? 0) >= 17
            ? previous!.segments
            : [
                ...(previous?.segments ?? []),
                { beforeHash: file.beforeHash, afterHash: file.afterHash },
              ],
        attribution:
          !continuous || previous?.attribution === "discontinuous"
            ? "discontinuous"
            : checkpoint.basis !== "fleet-reservation" ||
                previous?.attribution === "legacy"
              ? "legacy"
              : "reservation",
      });
    }
  }
  if (files.size > 200)
    throw Error(
      "Narrow this story to at most 200 changed files before reviewing.",
    );
  let bytes = 0;
  const readBlobs = new Map<string, Buffer>();
  const blob = async (value: string | undefined): Promise<Buffer> => {
    if (!value) return Buffer.alloc(0);
    const cached = readBlobs.get(value);
    if (cached) return cached;
    const path = await realpath(join(blobs, value));
    if (!within(blobs, path))
      throw Error("A saved change blob resolves outside its journal.");
    const data = await boundedContent(path);
    bytes += data.length;
    if (data.length > 2_000_000 || bytes > 32_000_000)
      throw Error("The story exceeds the bounded review snapshot size.");
    if (digest(data) !== value)
      throw Error("A saved change blob failed its content check.");
    readBlobs.set(value, data);
    return data;
  };
  let patch = "",
    additions = 0,
    deletions = 0;
  const baseFiles: Record<string, string> = {};
  const captured: StoryReviewRun["snapshot"]["files"] = [];
  for (const [path, file] of files) {
    // Equal whole-file endpoints prove a net no-op only for a continuous own
    // chain. With peers between reservations, an own fix may undo their edit.
    if (
      file.beforeHash === file.afterHash &&
      file.attribution !== "discontinuous"
    )
      continue;
    const entry: StoryReviewRun["snapshot"]["files"][number] = {
      path,
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
      attribution: file.attribution,
    };
    captured.push(entry);
    const segmentProjection = file.attribution === "discontinuous";
    if (
      segmentProjection &&
      (!file.allReservations ||
        file.segments.length > 16 ||
        file.segments.some(
          (segment) => !segment.beforeHash || !segment.afterHash,
        ))
    ) {
      limitations.add(
        `Changes to ${path} include an intervening edit. ${file.segments.length > 16 ? "The journal exceeds the bounded 16-segment projection." : !file.allReservations ? "Not every own segment has a Fleet reservation." : "Added/deleted-file transitions cannot be projected across peer edits."} They were not attributed to this story as one patch.`,
      );
      continue;
    }
    if (file.attribution === "legacy")
      limitations.add(
        `Attribution for ${path} uses an older scoped baseline rather than a Fleet reservation.`,
      );
    const candidate = resolve(root, path);
    if (!within(root, candidate))
      throw Error("A changed file resolves outside this project.");
    let currentHash: string | undefined, current: Buffer | undefined;
    try {
      const actual = await realpath(candidate);
      if (!within(root, actual))
        throw Error("A changed file resolves outside this project.");
      current = await boundedContent(actual);
      currentHash = digest(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const needsProjection = segmentProjection || currentHash !== file.afterHash;
    if (
      needsProjection &&
      (!file.beforeHash || !file.afterHash || !current || !file.allReservations)
    ) {
      limitations.add(
        `${path} changed after the story's last checkpoint. Capture its current contribution before reviewing.`,
      );
      continue;
    }
    if (file.binary) {
      limitations.add(`${path} is binary and needs a separate content review.`);
      continue;
    }
    const before = await blob(file.beforeHash),
      after = await blob(file.afterHash);
    const segmentBlobs: Array<{ before: Buffer; after: Buffer }> = [];
    if (segmentProjection)
      for (const segment of file.segments)
        segmentBlobs.push({
          before: await blob(segment.beforeHash),
          after: await blob(segment.afterHash),
        });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let oldText: string, newText: string;
    try {
      oldText = decoder.decode(before);
      newText = decoder.decode(after);
      if (needsProjection) {
        const currentText = decoder.decode(current!);
        const projection = segmentProjection
          ? projectStorySegments(
              segmentBlobs.map((segment) => ({
                before: decoder.decode(segment.before),
                after: decoder.decode(segment.after),
              })),
              currentText,
            )
          : projectStoryContribution(oldText, newText, currentText);
        if (!projection.ok) {
          limitations.add(
            `${path} ${segmentProjection ? "includes an intervening edit" : "changed after the story's last checkpoint"}. ${projection.reason}`,
          );
          continue;
        }
        if (projection.baseline === currentText) {
          limitations.add(
            `${path} has no net own source change after the journal segments and peer edits are separated.`,
          );
          continue;
        }
        oldText = projection.baseline;
        newText = currentText;
        entry.attribution = "reservation";
        entry.projection = {
          method: "unique-exact-context",
          baselineHash: digest(oldText),
          currentHash: currentHash!,
          hunks: projection.hunks,
          ...(segmentProjection
            ? { journalSegments: file.segments.length }
            : {}),
        };
      }
    } catch {
      limitations.add(`${path} cannot be decoded as UTF-8 source.`);
      continue;
    }
    baseFiles[path] = oldText;
    const unified = createTwoFilesPatch(
      file.beforeHash ? `a/${path}` : "/dev/null",
      file.afterHash ? `b/${path}` : "/dev/null",
      oldText,
      newText,
      "",
      "",
      { context: 3 },
    );
    patch += `diff --git a/${path} b/${path}\n${unified.replace(/^=+\n/, "")}`;
    for (const line of unified.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  const finalSource = await checkSourceBinding(root);
  if (!sourceBinding || sourceBinding !== finalSource)
    limitations.add(
      "Source changed during capture; this snapshot cannot certify the current code.",
    );
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const journalRevision = digest(JSON.stringify(changes.checkpoints));
  const patchHash = digest(patch);
  return {
    snapshot: {
      id: digest(
        JSON.stringify([
          task.id,
          branch,
          commit,
          finalSource,
          journalRevision,
          patchHash,
        ]),
      ),
      branch,
      commit,
      patchHash,
      journalRevision,
      sourceRevision: null,
      graphRevision: null,
      files: captured,
      additions,
      deletions,
    },
    patch,
    baseFiles,
    sourceBinding: finalSource,
    implementationRunIds: [
      ...new Set(changes.checkpoints.map((checkpoint) => checkpoint.runId)),
    ],
    limitations: [...limitations],
  };
}
