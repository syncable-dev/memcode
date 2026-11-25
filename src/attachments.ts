/**
 * Files people put into a conversation or a new piece of work. MemCode keeps them in its own
 * folder, and gives a worker copies in the folder it works in.
 */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** What the person says it shows. */
  note?: string;
  /** Where it came from, such as a comment in Slack. */
  from?: string;
}

export const MOST_ATTACHMENTS = 20;
export const LARGEST_ATTACHMENT = 15 * 1024 * 1024;
export const LONGEST_NOTE = 500;

export const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Adds files to a list, each file once. */
export function withAttachments(
  known: Attachment[],
  added: Attachment[],
): Attachment[] {
  const all = [...known];
  for (const file of added)
    if (
      !all.some(
        (other) => other.sha256 === file.sha256 && other.name === file.name,
      )
    )
      all.push(file);
  return all.slice(0, MOST_ATTACHMENTS);
}

/** What a message says when someone sends only files. */
export const filesOnly = (count: number) =>
  count === 1 ? "See the attached file." : "See the attached files.";
