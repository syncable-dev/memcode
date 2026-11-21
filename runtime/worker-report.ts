import { basename } from "node:path";

/** Where a report's local paths may point, so they can be made public-safe. */
export interface ReportRoots {
  repositories: string[];
  home: string;
}

const defaultExcerptLimit = 1400;
const markdownLink = /\[([^\]]*)\]\((<[^>]*>|[^)\s]*)\)/g;
const localRuntimeFolder = ".memcode/";

/** A worker's own report, with local file links and paths made repo-relative. */
export function publicReport(text: string, roots: ReportRoots): string {
  const repositories = [
    ...new Set(roots.repositories.filter(Boolean).map(withoutTrailingSlash)),
  ].sort((a, b) => b.length - a.length);
  const linked = text.replace(markdownLink, (link, label: string, target) =>
    publicLink(link, label, target, repositories),
  );
  return scrubPaths(linked, repositories, withoutTrailingSlash(roots.home));
}

/** Keeps whole paragraphs up to the limit so a long report still reads well. */
export function reportExcerpt(
  text: string,
  limit = defaultExcerptLimit,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const kept: string[] = [];
  let length = 0;
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    if (kept.length && length + paragraph.length + 2 > limit) break;
    kept.push(clipped(paragraph, limit));
    length += paragraph.length + 2;
  }
  return [...kept, "…"].join("\n\n");
}

function publicLink(
  link: string,
  label: string,
  rawTarget: string,
  repositories: string[],
): string {
  const target = rawTarget.replace(/^<|>$/g, "");
  if (!isAbsolutePath(target)) return link;
  const path = target.replace(/(:\d+)+$/, "").replace(/#L\d.*$/, "");
  const relativePath = insideRepository(path, repositories);
  if (!relativePath || relativePath.startsWith(localRuntimeFolder)) return label;
  return namesFile(label, relativePath)
    ? `\`${relativePath}\``
    : `${label} (\`${relativePath}\`)`;
}

function insideRepository(
  path: string,
  repositories: string[],
): string | undefined {
  const root = repositories.find((item) => path.startsWith(item + "/"));
  return root ? path.slice(root.length + 1) : undefined;
}

function namesFile(label: string, relativePath: string): boolean {
  const name = label.replace(/^`|`$/g, "");
  return name === relativePath || name === basename(relativePath);
}

function scrubPaths(
  text: string,
  repositories: string[],
  home: string,
): string {
  let scrubbed = text;
  for (const root of repositories)
    scrubbed = scrubbed.replaceAll(root + "/", "");
  return home ? scrubbed.replaceAll(home + "/", "~/") : scrubbed;
}

function isAbsolutePath(target: string): boolean {
  return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
}

function withoutTrailingSlash(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function clipped(paragraph: string, limit: number): string {
  if (paragraph.length <= limit) return paragraph;
  return paragraph.slice(0, paragraph.lastIndexOf(" ", limit)).trimEnd();
}
