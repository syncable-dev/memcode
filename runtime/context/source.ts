import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ContextBinding, EvidenceItem, SourceRevision } from "./contracts";

const execute = promisify(execFile);
export const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
export async function gitText(root: string, args: string[]): Promise<string> {
  return (
    await execute("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout;
}
export function normalizedPath(value: string): string {
  return value
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}
/** Memtrace names a file by absolute path or prefixed with its repo id; callers want it inside the repo. */
export function repoRelativePath(
  project: { path?: string | null; repoId?: string | null },
  raw: string,
): string {
  const path = normalizedPath(raw),
    root = normalizedPath(project.path ?? "");
  if (root && path.toLowerCase().startsWith(root.toLowerCase() + "/"))
    return path.slice(root.length + 1);
  return project.repoId && path.startsWith(project.repoId + "/")
    ? path.slice(project.repoId.length + 1)
    : path;
}
const blocked =
  /(^|\/)(\.git|\.memcode|\.memdb|\.memtrace|node_modules|target|dist|dist-runtime)(\/|$)/;
export async function repoFiles(root: string): Promise<string[]> {
  return [
    ...new Set(
      (
        await gitText(root, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ])
      )
        .split("\0")
        .filter(Boolean)
        .map(normalizedPath),
    ),
  ]
    .filter((p) => !blocked.test(p))
    .sort();
}
export async function sourceRevision(root: string): Promise<SourceRevision> {
  const [head, branch, status, files] = await Promise.all([
    gitText(root, ["rev-parse", "HEAD"]),
    gitText(root, ["branch", "--show-current"]),
    gitText(root, ["status", "--porcelain=v1", "-z"]),
    repoFiles(root),
  ]);
  const digest = createHash("sha256").update(head).update(branch);
  for (const file of files) {
    digest.update(file).update("\0");
    try {
      const path = resolve(root, file),
        info = await lstat(path);
      if (info.isSymbolicLink()) {
        digest.update("<link>" + (await readlink(path)));
        continue;
      }
      if (info.size > 16 * 1024 * 1024) {
        // Refuse to claim a content-bound cache for files too large to inspect.
        throw new Error(`Revision scan exceeds 16 MiB per-file limit: ${file}`);
      }
      digest.update(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        digest.update("<deleted>");
      else throw error;
    }
  }
  return {
    head: head.trim(),
    branch: branch.trim(),
    dirty: !!status.trim(),
    fingerprint: digest.digest("hex"),
    files: files.length,
  };
}
export function visible(file: string, scope: string[]): boolean {
  return (
    !scope.length ||
    scope.some((s) => file === s || file.startsWith(s.replace(/\/$/, "") + "/"))
  );
}
export async function checkedPath(
  binding: ContextBinding,
  raw: string,
): Promise<{ file: string; absolute: string }> {
  const root = await realpath(binding.project.path!);
  let file = normalizedPath(raw);
  if (file.startsWith(binding.project.repoId + "/"))
    file = file.slice(binding.project.repoId!.length + 1);
  const absolute = await realpath(
    isAbsolute(file) ? file : resolve(root, file),
  );
  file = normalizedPath(relative(root, absolute));
  if (
    !file ||
    file === ".." ||
    file.startsWith("../") ||
    isAbsolute(file) ||
    blocked.test(file)
  )
    throw new Error(
      "Source path is outside the repository visibility boundary",
    );
  // realpath closes junction/symlink escapes before any content is read.
  if (!absolute.startsWith(root + sep) && absolute !== root)
    throw new Error("Source path escapes repository");
  if (!visible(file, binding.scope.map(normalizedPath)))
    throw new Error(`Source is outside this worker's visibility: ${file}`);
  return { file, absolute };
}
export async function literalSource(
  binding: ContextBinding,
  raw: string,
  start: number,
  end: number,
  symbol = "",
  nodeId?: string,
): Promise<EvidenceItem> {
  const { file, absolute } = await checkedPath(binding, raw);
  const body = await readFile(absolute, "utf8");
  if (body.includes("\0") || Buffer.byteLength(body) > 2 * 1024 * 1024)
    throw new Error("Binary or oversized source cannot be excerpted");
  const lines = body.split(/\r?\n/),
    from = Math.max(1, start),
    to = Math.min(lines.length, Math.max(from, end), from + 119);
  if (from > lines.length)
    throw new Error(`Stale graph location: ${file}:${from}`);
  const excerpt = lines.slice(from - 1, to).join("\n");
  const name = symbol.split(/::|\./).at(-1) ?? "";
  if (/^[A-Za-z_$][\w$]*$/.test(name) && !excerpt.includes(name))
    throw new Error(
      `Indexed declaration no longer matches the working file at ${file}:${from}`,
    );
  return {
    id: `source:${hash(file + ":" + from + ":" + to).slice(0, 16)}`,
    kind: "source",
    handle: { symbol, file, ...(nodeId ? { nodeId } : {}) },
    ref: { file, startLine: from, endLine: to, sha256: hash(body) },
    text: lines
      .slice(from - 1, to)
      .map((line, i) => `${from + i}: ${line}`)
      .join("\n"),
    origin: "verified-working-file",
  };
}
