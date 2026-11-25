import type { Attachment } from "./attachments";
import { keepFile } from "./components/Attachments";
import { reportDocument, type InboxFile, type InboxItem } from "./inbox";

const asFile = (file: InboxFile, base64: string) =>
  new File(
    [Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))],
    file.name,
    { type: file.mime },
  );

/**
 * Puts a report's evidence into the goal being defined: the report itself with its comments
 * as a document, then every file that came with it or with a comment. A file that cannot be
 * got is named at the end; the rest stay.
 */
export async function attachReport(
  projectId: string,
  item: InboxItem,
  add: (file: Attachment) => void,
  starting: () => boolean,
): Promise<void> {
  const document = new File([reportDocument(item)], "slack-report.md", {
    type: "text/markdown",
  });
  add(await keepFile(document, "the Inbox"));
  const brought = [
    ...item.files.map((file) => ({
      file,
      from: `${item.reporter.name}'s report`,
    })),
    ...item.replies.flatMap((reply) =>
      reply.files.map((file) => ({
        file,
        from: `${reply.author.name}'s comment`,
      })),
    ),
  ];
  const missing: string[] = [];
  for (const { file, from } of brought) {
    if (!starting()) return;
    if (!file.sha256) continue;
    try {
      const { base64 } = await window.memcode.inboxFile({
        projectId,
        sha256: file.sha256,
      });
      add(await keepFile(asFile(file, base64), from));
    } catch {
      missing.push(file.name);
    }
  }
  if (missing.length)
    throw new Error(
      `Not attached: ${missing.join(", ")}. Try again from the Inbox.`,
    );
}
