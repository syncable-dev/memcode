import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hands text to a command as a private file, removed as soon as the command returns. */
export async function withTemporaryFile<T>(
  content: string,
  use: (file: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "memcode-"));
  const file = join(directory, "message.txt");
  try {
    await writeFile(file, content, { mode: 0o600 });
    return await use(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
