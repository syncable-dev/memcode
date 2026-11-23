import { createHash } from "node:crypto";
import type { BrowserImage } from "../../src/browser";
import type { NativeHost } from "../host";
import type {
  BrowserEngine,
  BrowserPage,
  BrowserTabs,
  CaptureRequest,
  InteractionFeedback,
  InteractionRequest,
  SurfacePlacement,
} from "./engine";
import { inspectNativePage, interactNatively, type NativeScripts } from "./webkit-driver";

/** What `src-tauri/src/browser/macos` reports for each surface of a card. */
interface NativePageState {
  nativeId: string;
  opener: string | null;
  url: string;
  title: string;
  loading: boolean;
  loads: number;
}

/** WebKit tells MemCode nothing on its own, so the runtime asks this often. */
const REFRESH_MS = 300;
const NAVIGATION_TIMEOUT_MS = 20000;
const NAVIGATION_POLL_MS = 80;
const HISTORY_QUIET_MS = 1500;

/** A stable WebKit data store per card, unrelated to any other card's. */
function cardProfile(taskId: string) {
  return "worker-" + createHash("sha256").update(taskId).digest("hex");
}

class WebKitPage implements BrowserPage {
  private current: Omit<NativePageState, "nativeId" | "opener"> = {
    url: "about:blank",
    title: "",
    loading: false,
    loads: 0,
  };
  private closed = false;
  private navigated: Array<() => void> = [];
  private loaded: Array<() => void> = [];
  private closing: Array<() => void> = [];
  constructor(
    readonly nativeId: string,
    private tabs: WebKitTabs,
  ) {}
  url() {
    return this.current.url;
  }
  async title() {
    return this.current.title;
  }
  isClosed() {
    return this.closed;
  }
  async goto(url: string) {
    const before = this.current.loads;
    await this.tabs.call("browser_navigate", { nativeId: this.nativeId, url });
    await this.settle(before);
  }
  /** Back, forward and reload: the page moves on its own once WebKit has it. */
  async travel(action: "back" | "forward" | "reload") {
    const before = this.current.loads;
    await this.tabs.call("browser_history", { nativeId: this.nativeId, action });
    await this.settle(before, false);
  }
  inspect() {
    return inspectNativePage(this.scripts());
  }
  scripts(): NativeScripts {
    return {
      url: () => this.url(),
      title: () => this.title(),
      run: (script) =>
        this.tabs.call<string>("browser_eval", { nativeId: this.nativeId, script }),
      input: (input) => this.tabs.call("browser_input", { nativeId: this.nativeId, input }),
      travel: (action) => this.travel(action),
    };
  }
  onNavigated(listener: () => void) {
    this.navigated.push(listener);
  }
  onLoaded(listener: () => void) {
    this.loaded.push(listener);
  }
  onClosed(listener: () => void) {
    this.closing.push(listener);
  }
  update(next: NativePageState) {
    const previous = this.current;
    this.current = { url: next.url, title: next.title, loading: next.loading, loads: next.loads };
    if (next.loads !== previous.loads || next.url !== previous.url)
      for (const listener of this.navigated) listener();
    if (next.title !== previous.title || (previous.loading && !next.loading))
      for (const listener of this.loaded) listener();
  }
  markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closing) listener();
  }
  /**
   * Waits until a new document has committed and stopped loading. A navigation
   * that stops without committing failed (no network, refused address). Back or
   * forward with no history does nothing, so those give up quietly.
   */
  private async settle(before: number, expectNavigation = true) {
    const started = Date.now();
    let loading = false;
    for (;;) {
      await this.tabs.sync();
      if (this.closed) throw Error("The browser tab closed.");
      loading ||= this.current.loading;
      const committed = this.current.loads > before,
        elapsed = Date.now() - started;
      if (committed && !this.current.loading) return;
      if (loading && !committed && !this.current.loading)
        throw Error("The page could not be opened.");
      if (!expectNavigation && !loading && !committed && elapsed > HISTORY_QUIET_MS) return;
      if (elapsed > NAVIGATION_TIMEOUT_MS) {
        if (committed) return;
        throw Error("The page took too long to open.");
      }
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_POLL_MS));
    }
  }
}

function webkitPage(page: BrowserPage): WebKitPage {
  return page as WebKitPage;
}

class WebKitTabs implements BrowserTabs {
  private pages = new Map<string, WebKitPage>();
  private listener?: (page: BrowserPage, replaces?: BrowserPage) => void;
  private timer?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private stopped = false;
  constructor(
    private host: NativeHost,
    private taskId: string,
  ) {}
  call<T = unknown>(method: string, input: Record<string, unknown> = {}) {
    return this.host.call<T>(method, { taskId: this.taskId, ...input });
  }
  async newPage() {
    const { nativeId } = await this.call<{ nativeId: string }>("browser_create", {
      profile: cardProfile(this.taskId),
    });
    const page = new WebKitPage(nativeId, this);
    this.pages.set(nativeId, page);
    this.watch();
    return page;
  }
  onPage(listener: (page: BrowserPage, replaces?: BrowserPage) => void) {
    this.listener = listener;
  }
  /** One refresh at a time; callers that arrive meanwhile share it. */
  sync() {
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  async interact(page: BrowserPage, request: InteractionRequest): Promise<InteractionFeedback> {
    return interactNatively(webkitPage(page).scripts(), request);
  }
  async capture(page: BrowserPage, request: CaptureRequest): Promise<BrowserImage> {
    const image = await this.call<{ data: string; width: number; height: number }>(
      "browser_capture",
      { nativeId: webkitPage(page).nativeId, scale: request.scale, format: request.format },
    );
    return {
      mimeType: `image/${request.format}`,
      data: image.data,
      width: Math.round(image.width),
      height: Math.round(image.height),
    };
  }
  async resize() {}
  async closePage(page: BrowserPage) {
    const native = webkitPage(page);
    await this.call("browser_close", { nativeId: native.nativeId });
    this.pages.delete(native.nativeId);
    native.markClosed();
  }
  async close() {
    this.stop();
    await this.call("browser_close_task");
    for (const page of this.pages.values()) page.markClosed();
    this.pages.clear();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  private watch() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.sync().catch(() => {}), REFRESH_MS);
    this.timer.unref?.();
  }
  private async refresh() {
    if (this.stopped) return;
    const states = await this.call<NativePageState[]>("browser_pages");
    const present = new Set<string>();
    for (const state of states) {
      present.add(state.nativeId);
      this.adopt(state)?.update(state);
    }
    for (const [nativeId, page] of this.pages)
      if (!present.has(nativeId)) {
        this.pages.delete(nativeId);
        page.markClosed();
      }
  }
  /** Known tabs, plus windows a page opened; a tab still being created waits. */
  private adopt(state: NativePageState) {
    const known = this.pages.get(state.nativeId);
    if (known || !state.opener) return known;
    const popup = new WebKitPage(state.nativeId, this);
    this.pages.set(state.nativeId, popup);
    this.listener?.(popup);
    return popup;
  }
}

/** macOS: each card's tab is a real WKWebView over the card. */
export class WebKitEngine implements BrowserEngine {
  readonly native = true;
  private cards = new Set<WebKitTabs>();
  constructor(private host: NativeHost) {}
  connected() {
    return true;
  }
  async open(_viewport: unknown, _density: number, taskId: string) {
    const tabs = new WebKitTabs(this.host, taskId);
    this.cards.add(tabs);
    return tabs;
  }
  async surface(taskId: string, page: BrowserPage | undefined, placement: SurfacePlacement) {
    if (!page) {
      await this.host.call("browser_hide_all");
      return;
    }
    await this.host.call("browser_surface", {
      taskId,
      nativeId: webkitPage(page).nativeId,
      ...placement,
    });
  }
  async close() {
    const allocated = this.cards.size > 0;
    for (const card of this.cards) card.stop();
    this.cards.clear();
    if (allocated) await this.host.call("browser_close_all");
  }
}
