import { createHash } from "node:crypto";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";
import type { NativeHost } from "../host";
import type { BrowserSession } from "./pool";
import { browserCapture, browserDeadline } from "./capture";

/** Native WebView2 pages. The user and CDP operate on the same DOM and surface. */
export class NativeBrowserPool {
  readonly native = true;
  private opening?: Promise<Browser>;
  private creating: Promise<unknown> = Promise.resolve();
  private browser?: Browser;
  private allocated = false;
  private endpoint?: string;
  private discovery?: CDPSession;
  private recovering = new Set<string>();
  private popupConnections = new Set<Browser>();
  private nativePages = new Map<string, Page>();
  private ids = new WeakMap<Page, string>();
  private sessions = new Map<
    string,
    {
      pages: Set<Page>;
      routes: Array<Parameters<BrowserContext["route"]>>;
      onPage?: (page: Page, replaces?: Page) => void;
    }
  >();
  constructor(private host: NativeHost) {}
  connected() {
    return this.browser?.isConnected() ?? false;
  }
  async context(
    _viewport: { width: number; height: number },
    _density = 1,
    taskId = "",
  ): Promise<BrowserSession> {
    const pages = new Set<Page>();
    const routes: Array<Parameters<BrowserContext["route"]>> = [];
    const session = {
      pages,
      routes,
      onPage: undefined as ((page: Page, replaces?: Page) => void) | undefined,
    };
    this.sessions.set(taskId, session);
    return {
      newPage: async () => {
        // WebView2 controller creation pumps the Windows UI loop. Serialize
        // this short startup phase so two workers cannot re-enter it.
        const opening = this.creating
          .catch(() => {})
          .then(async () => {
            this.allocated = true;
            const created = await this.host.call<{
              nativeId: string;
              marker: string;
              endpoint: string;
            }>("browser_create", {
              taskId,
              profile:
                "worker-" +
                createHash("sha256").update(taskId).digest("hex").slice(0, 40),
            });
            // The browser ends with its last page. A page opened after that is in a new
            // one, which the connection to the old one never shows.
            if (this.endpoint !== created.endpoint) this.opening = undefined;
            this.endpoint = created.endpoint;
            this.opening ??= (async () => {
              const { chromium } = await import("playwright-core");
              const browser = await chromium.connectOverCDP(created.endpoint, {
                timeout: 15000,
              });
              this.browser = browser;
              // WebView2 replaces a new-window controller's initial WebContents.
              // Playwright's existing auto-attach session can retain that dead
              // initial target. Discover the committed replacement, then attach a
              // fresh CDP client to that actual native page (never a mirrored tab).
              this.discovery = await browser.newBrowserCDPSession();
              const discovered = ({ targetInfo }: any) => {
                if (
                  targetInfo.type === "page" &&
                  targetInfo.openerId &&
                  /^https?:/.test(targetInfo.url)
                )
                  void this.recoverPopup(targetInfo.targetId).catch((error) =>
                    console.warn("Native popup connection:", String(error)),
                  );
              };
              this.discovery.on("Target.targetCreated", discovered);
              this.discovery.on("Target.targetInfoChanged", discovered);
              await this.discovery.send("Target.setDiscoverTargets", {
                discover: true,
              });
              browser.once("disconnected", () => {
                if (this.browser !== browser) return;
                this.browser = undefined;
                this.opening = undefined;
              });
              return browser;
            })().catch((error) => {
              this.opening = undefined;
              throw error;
            });
            const browser = await this.opening;
            let page: Page | undefined;
            for (let attempt = 0; attempt < 100; attempt++) {
              page = browser
                .contexts()
                .flatMap((context) => context.pages())
                .find((candidate) => candidate.url() === created.marker);
              if (page) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (!page)
              throw Error(
                "The native browser did not expose its work-item tab.",
              );
            this.ids.set(page, created.nativeId);
            this.nativePages.set(created.nativeId, page);
            pages.add(page);
            page.once("close", () => pages.delete(page!));
            for (const [pattern, handler, options] of routes)
              await page.route(pattern, handler, options);
            return page;
          });
        this.creating = opening;
        return opening;
      },
      route: async (...args) => {
        routes.push(args);
        for (const page of pages) await page.route(...args);
      },
      newCDPSession: (page) => {
        if (!("context" in page))
          throw Error("Native browser frames are not CDP session owners.");
        return (page as Page).context().newCDPSession(page);
      },
      close: async () => {
        await this.host.call("browser_close_task", { taskId });
        pages.clear();
        this.sessions.delete(taskId);
      },
      onPage: (callback) => {
        session.onPage = callback;
      },
    };
  }
  async surface(
    taskId: string,
    page: Page | undefined,
    input: Record<string, unknown>,
  ) {
    if (!page) {
      await this.host.call("browser_hide_all");
      return;
    }
    await this.host.call("browser_surface", {
      taskId,
      nativeId: await this.nativeId(page),
      ...input,
    });
  }
  async busy(taskId: string, page: Page, busy: boolean) {
    await this.host.call("browser_busy", {
      taskId,
      nativeId: await this.nativeId(page),
      busy,
    });
  }
  async closePage(taskId: string, page: Page) {
    await this.host.call("browser_close", {
      taskId,
      nativeId: await this.nativeId(page),
    });
  }
  async close() {
    this.sessions.clear();
    if (this.allocated) await this.host.call("browser_close_all");
    await this.discovery?.detach().catch(() => {});
    await Promise.all(
      [...this.popupConnections].map((browser) =>
        browser.close().catch(() => {}),
      ),
    );
    this.popupConnections.clear();
    this.nativePages.clear();
  }
  private async recoverPopup(targetId: string) {
    if (!this.endpoint || this.recovering.has(targetId)) return;
    this.recovering.add(targetId);
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(this.endpoint, {
      timeout: 10000,
    });
    let adopted = false;
    try {
      for (const page of browser
        .contexts()
        .flatMap((context) => context.pages())) {
        const session = await page.context().newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        if (targetInfo.targetId !== targetId) continue;
        adopted = await this.popup(page, true);
        if (adopted) {
          this.popupConnections.add(browser);
          page.once("close", () => {
            this.popupConnections.delete(browser);
            void browser.close().catch(() => {});
          });
        }
        break;
      }
    } finally {
      if (!adopted) await browser.close().catch(() => {});
    }
  }
  private async popup(page: Page, committed = false) {
    // WebView2 forbids DOM interaction with a new-window control until its
    // requested content has loaded. The initial blank target is not ready.
    await page.waitForURL(/^https?:\/\//, {
      waitUntil: "domcontentloaded",
      timeout: 8000,
    });
    await page.waitForFunction(
      () => typeof (window as any).__memcodeNativePopup === "boolean",
      undefined,
      { timeout: 8000 },
    );
    const identity = await page.evaluate(() => ({
      popup: (window as any).__memcodeNativePopup,
      taskId: (window as any).__memcodeNativeOwner,
      id: (window as any).__memcodeNativeTab,
    }));
    if (!identity.popup) return false;
    const session = this.sessions.get(identity.taskId);
    const previous = this.nativePages.get(identity.id);
    if (!session || (previous && !previous.isClosed() && !committed))
      return false;
    this.ids.set(page, identity.id);
    this.nativePages.set(identity.id, page);
    if (previous) session.pages.delete(previous);
    session.pages.add(page);
    page.once("close", () => session.pages.delete(page));
    for (const [pattern, handler, options] of session.routes)
      await page.route(pattern, handler, options);
    session.onPage?.(page, previous);
    return true;
  }
  async capture(
    taskId: string,
    page: Page,
    scale: "css" | "device",
    viewport: { width: number; height: number },
    density = 1,
  ): Promise<string> {
    const nativeId = await browserDeadline(
      this.nativeId(page),
      3000,
      "Browser tab lookup",
    );
    return browserCapture(
      async () => {
        const reply = await this.host.call<{ data: string }>(
          "browser_capture",
          {
            taskId,
            nativeId,
            scale,
            ...viewport,
          },
        );
        if (!reply.data) throw Error("Native browser returned no image.");
        return reply.data;
      },
      async () => {
        const session = await browserDeadline(
          page.context().newCDPSession(page),
          1000,
          "Browser compositor connection",
        );
        try {
          const result = await browserDeadline(
            session.send("Page.captureScreenshot", {
              format: "png",
              fromSurface: true,
              captureBeyondViewport: false,
              clip: {
                x: 0,
                y: 0,
                ...viewport,
                scale: scale === "css" ? 1 / density : 1,
              },
            }),
            3500,
            "Browser compositor screenshot",
          );
          return result.data;
        } finally {
          void session.detach().catch(() => {});
        }
      },
    );
  }
  private async nativeId(page: Page): Promise<string> {
    const cached = this.ids.get(page);
    if (cached) return cached;
    await page.waitForFunction(
      () => typeof (window as any).__memcodeNativeTab === "string",
      undefined,
      { timeout: 8000 },
    );
    const id = await page.evaluate(
      () => (window as any).__memcodeNativeTab as string,
    );
    this.ids.set(page, id);
    return id;
  }
}
