import { writeFile } from "node:fs/promises";

/**
 * Says a file came from somewhere else. Windows then warns about it, and Office opens it
 * protected, like a download. Elsewhere, and on a disk without such marks, it does nothing.
 */
export async function markDownloaded(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  await writeFile(
    `${path}:Zone.Identifier`,
    "[ZoneTransfer]\r\nZoneId=3\r\n",
  ).catch(() => {});
}
