import { readFile, realpath, stat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { Project, WorkItem } from "../src/shared";
import { within, now } from "./local";

/** A Class B refresh reads the current bounded source, rather than escalating overlap. */
export async function rereadFleetSource(project: Project, task: WorkItem) {
  const workspace = task.run.workspace ?? project.path;
  if (!workspace) throw Error("The shared project folder is unavailable.");
  const root = await realpath(workspace);
  const files = [
    ...new Set([
      ...(task.scope ?? []),
      ...(task.evidence?.symbols ?? []).map((symbol) => symbol.file),
    ]),
  ].slice(0, 20);
  const records = [];
  let remaining = 16000;
  for (const file of files) {
    const candidate = resolve(workspace, file);
    if (
      !within(workspace, candidate) &&
      !(isAbsolute(file) && within(root, candidate))
    )
      throw Error("Fleet source scope is outside this project.");
    let path: string;
    try {
      path = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        records.push({ file, exists: false });
        continue;
      }
      throw error;
    }
    if (!within(root, path))
      throw Error("Fleet source scope resolves outside this project.");
    const info = await stat(path);
    if (!info.isFile())
      throw Error("Choose exact source files for a shared Fleet edit.");
    if (info.size > 1_000_000)
      throw Error("Narrow this large Fleet source scope before continuing.");
    const bytes = await readFile(path),
      after = await stat(path);
    if (info.mtimeMs !== after.mtimeMs || bytes.length !== after.size)
      throw Error(
        "Shared source changed during re-read. Inspect again before editing.",
      );
    const fullText = bytes.toString("utf8"),
      text = fullText.slice(0, Math.min(12000, remaining));
    remaining -= text.length;
    records.push({
      file: relative(root, path).replaceAll("\\", "/"),
      exists: true,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text,
      truncated: text.length < fullText.length,
    });
  }
  const result = { at: now(), basis: "literal current files", files: records };
  if (task.run.workspace) {
    const directory = join(task.run.workspace, ".memcode", "workers", task.id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "fleet-reread.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
  }
  return result;
}
