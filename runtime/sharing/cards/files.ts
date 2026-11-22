import { realpath, readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AppState, Artifact } from "../../../src/shared";
import { canonicalArtifactRoots } from "../../files";
import { within } from "../../local";

/** The most a project can share in one file (MemSync ADR-0014). */
export const LARGEST_SHARED_FILE = 5 * 1024 * 1024;

// The types Team Sync publishes under, kept here because Team Sync keeps its own private.
const fileTypes: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".patch": "text/x-diff",
  ".diff": "text/x-diff",
};
export const fileTypeOf = (name: string) =>
  fileTypes[extname(name).toLowerCase()] ?? "application/octet-stream";

/** How a file from a card is previewed, by its type. */
export const previewKindOf = (mime: string): Artifact["kind"] =>
  mime.startsWith("image/") ? "image" : /html/.test(mime) ? "html" : "text";

/**
 * The bytes of a file a task saved, when it may be shared: only one of the
 * task's own saved outputs, at most 5 MB.
 */
export async function shareableFile(
  dataDir: string,
  state: AppState,
  taskId: string,
  artifactId: string,
) {
  const task = state.tasks.find((item) => item.id === taskId);
  const artifact = state.artifacts.find(
    (item) => item.id === artifactId && item.taskId === taskId,
  );
  if (!task || !artifact)
    throw new Error("Choose a file this task saved to share it.");
  const path = await realpath(artifact.path);
  const roots = await canonicalArtifactRoots(dataDir, task);
  if (!roots.some((root) => within(root, path)))
    throw new Error("Only files this task saved can be shared.");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Only a file can be shared.");
  if (info.size > LARGEST_SHARED_FILE)
    throw new Error(
      "That file is larger than 5 MB, which is the most a project can share in one file.",
    );
  const name = basename(artifact.name);
  return {
    name,
    mime: fileTypeOf(name),
    kind:
      artifact.purpose === "report"
        ? ("report" as const)
        : ("artifact" as const),
    bytes: await readFile(path),
  };
}
