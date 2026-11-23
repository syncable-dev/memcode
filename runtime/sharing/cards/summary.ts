import type { WorkItem } from "../../../src/shared";
import type { RunSummary } from "../../../src/team-session";
import { LONGEST_SUMMARY, publicText } from "./entries";

/**
 * What the others on a shared project read of a worker's run (MemSync ADR-0019): the
 * summary it ends a round of work with, written for people who see neither the
 * conversation nor the worker's computer.
 */

/** The line the brief asks a worker to start its summary for the project with. */
export const SUMMARY_HEADING = "Summary for the project:";

// The heading as workers write it: plain, in bold, as a Markdown heading, or as the
// "Project summary:" an earlier brief led them to.
const HEADING =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(?:summary for the project|project summary):?(?:\*\*|__)?:?[ \t]*/gim;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]+)(?:[ \t]+"[^"\n]*")?\)/g;
const WEB_ADDRESS = /^(?:https?:|mailto:)/i;
// What publicText leaves of a path in a home folder: shown as the file's name.
const PATH_IN_A_HOME = /<local-home>\/(?:[^\s)\]`'"]*\/)?([^\s/)\]`'"]+)/g;

/**
 * What a finished round of work says it did: the section of the worker's last message
 * headed for the project, or the whole message when it has no such section.
 */
export function summaryOf(
  task: WorkItem,
  projectFolders: string[] = [],
): RunSummary | undefined {
  const { state, startedAt, workspace, worktree } = task.run;
  if (state !== "finished" || !startedAt) return undefined;
  const last = task.messages
    .filter(
      (message) => message.role === "assistant" && message.at >= startedAt,
    )
    .at(-1);
  if (!last) return undefined;
  const folders = [workspace, worktree, ...projectFolders].filter(
    (folder): folder is string => !!folder,
  );
  const text = readableSummary(sectionForTheProject(last.text), folders).slice(
    0,
    LONGEST_SUMMARY,
  );
  return text ? { text, at: last.at } : undefined;
}

function sectionForTheProject(message: string): string {
  const headings = [...message.matchAll(HEADING)];
  const last = headings.at(-1);
  return last ? message.slice(last.index + last[0].length) : message;
}

/**
 * A summary as someone on another computer can read it: a link to a file on the
 * worker's computer becomes the file's name, a path in the project becomes the path
 * in the project, any other local path the file's name, and no credential is left.
 */
export function readableSummary(text: string, folders: string[]): string {
  const unlinked = text.replace(
    MARKDOWN_LINK,
    (link, label: string, target: string) =>
      WEB_ADDRESS.test(target) ? link : label,
  );
  const inProject = folders.reduce(
    (written, folder) =>
      written
        .split(`${folder}/`)
        .join("")
        .split(`${encodeURI(folder)}/`)
        .join(""),
    unlinked,
  );
  return publicText(inProject).replace(PATH_IN_A_HOME, "$1").trim();
}
