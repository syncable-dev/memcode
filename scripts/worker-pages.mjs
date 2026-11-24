import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

/**
 * Connects to the browser of workers' pages, which is not the one MemCode's window is in. Its
 * port is the system's choice, and the browser writes it into its own folder.
 */
export async function connectWorkerPages(profile) {
  const file = join(
    profile,
    "webview-workers",
    "EBWebView",
    "DevToolsActivePort",
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = await readFile(file, "utf8").catch(() => "");
    if (/^\d+\n/.test(port))
      return chromium.connectOverCDP(
        `http://127.0.0.1:${port.split("\n")[0]}`,
        { timeout: 10000 },
      );
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error("The browser of workers' pages did not start");
}
