import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** A MemCode that was ended and opened again at once is still saving: it is waited for. */
const waitMs = 10_000;

/** One MemCode writes a profile. Answers with what lets it go again. */
export async function holdProfile(
  dataDir: string,
  { wait = waitMs, pid = process.pid }: { wait?: number; pid?: number } = {},
): Promise<() => Promise<void>> {
  const path = join(dataDir, "runtime.lock");
  await mkdir(dataDir, { recursive: true });
  const until = Date.now() + wait;
  for (;;) {
    try {
      const lock = await open(path, "wx");
      await lock.writeFile(
        JSON.stringify({
          owner: "memcode-runtime",
          pid,
          createdAt: new Date().toISOString(),
        }),
      );
      await lock.close();
      return () => unlink(path).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await holderOf(path);
    if (holder === "gone")
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && Date.now() >= until) throw error;
      });
    else if (Date.now() >= until)
      throw new Error(
        holder === "alive"
          ? "This MemCode workspace is already open. Close its other window before starting another writer."
          : "MemCode has an unreadable runtime lock. The workspace was preserved.",
      );
    if (holder !== "gone") await new Promise((done) => setTimeout(done, 200));
  }
}

async function holderOf(path: string): Promise<"alive" | "gone" | "unreadable"> {
  let pid: unknown;
  try {
    pid = (JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid;
  } catch {
    // Let go of in between, being written this moment, or damaged.
    return "unreadable";
  }
  if (typeof pid !== "number") return "unreadable";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
  }
  return "alive";
}
