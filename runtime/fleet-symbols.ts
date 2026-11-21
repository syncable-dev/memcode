import { isAbsolute, posix, relative } from "node:path";
import type { ChangeKind } from "../src/fleet";
import { repoRelativePath } from "./context/source";
import { within } from "./local";

const separator = "::";

export interface SymbolRoots {
  /** The checkout the worker edits. */
  workspace: string;
  project: { path?: string | null; repoId?: string | null };
}

/**
 * The one name every worker in a goal uses for a symbol: `file::symbol`, with the file
 * relative to the checkout. Fleet matches workers by this exact text, so two ways of
 * writing the same path must come out the same.
 */
export function symbolIdentity(raw: string, roots: SymbolRoots): string {
  const text = raw.trim().replaceAll("\\", "/");
  const at = text.indexOf(separator);
  const path = (at < 0 ? text : text.slice(0, at)).trim();
  const symbol = at < 0 ? "" : text.slice(at + separator.length).trim();
  if (!symbol && !looksLikeFile(path))
    throw Error(
      `Name the file with the symbol, as file::${path}. Use the file path alone when you change a whole file.`,
    );
  const file = fileInside(path, roots);
  return symbol ? file + separator + symbol : file;
}

export const fileOf = (identity: string) => identity.split(separator)[0];

function looksLikeFile(path: string) {
  return path.includes("/") || /\.[A-Za-z0-9]+$/.test(path);
}

function fileInside(path: string, roots: SymbolRoots): string {
  const outside = Error(`${path} is outside this project.`);
  if (isAbsolute(path)) {
    const root = [roots.workspace, roots.project.path].find(
      (candidate) => candidate && within(candidate, path),
    );
    if (!root) throw outside;
    return relative(root, path).replaceAll("\\", "/");
  }
  const file = posix.normalize(repoRelativePath(roots.project, path));
  if (file === ".." || file.startsWith("../")) throw outside;
  return file;
}

/** The typed intent Fleet classifies by. `change` has no closer engine kind than a logic fix. */
export function engineIntent(kind: ChangeKind, symbols: string[]): unknown {
  switch (kind) {
    case "add":
      return { feature_add: { surface: "new_symbol" } };
    case "change":
    case "fix":
      return { bug_fix: { defect: "logic_error" } };
    case "rename":
      return { refactor: { pattern: "rename_symbol" } };
    case "signature":
      return { refactor: { pattern: "change_signature" } };
    case "move":
      return { refactor: { pattern: "move_symbol" } };
    case "remove":
      return { cleanup: { kind: "dead_code" } };
    case "format":
      return { cleanup: { kind: "format_only" } };
    case "test":
      return { test_add: { covers: symbols } };
    case "docs":
      return "docs_only";
  }
}

/** Whether an intent as Fleet stores it reshapes or removes what other code relies on. */
export function engineBreaks(intent: unknown): boolean {
  const typed = intent as {
    refactor?: { pattern?: string };
    cleanup?: { kind?: string };
  } | null;
  return (
    ["change_signature", "move_symbol"].includes(typed?.refactor?.pattern ?? "") ||
    typed?.cleanup?.kind === "dead_code"
  );
}
