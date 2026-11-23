import { release as osRelease } from "node:os";
import type { NativeHost } from "../host";
import type { BrowserEngine } from "./engine";
import { NativeBrowserPool } from "./native-pool";
import { HeadlessEngine, WebView2Engine } from "./playwright-engine";
import { WebKitEngine } from "./webkit-engine";

/** Darwin 23 is macOS 14, the first with a WebKit data store per card. */
const FIRST_NATIVE_DARWIN = 23;

export function browserEngineFor(
  host?: NativeHost,
  platform: NodeJS.Platform = process.platform,
  release = osRelease(),
): BrowserEngine {
  if (host && platform === "win32") return new WebView2Engine(new NativeBrowserPool(host));
  if (host && platform === "darwin" && Number.parseInt(release, 10) >= FIRST_NATIVE_DARWIN)
    return new WebKitEngine(host);
  return new HeadlessEngine();
}
