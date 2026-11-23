import type { Page, Route } from "playwright-core";
import { browserURL, type BrowserImage } from "../../src/browser";
import type {
  BrowserEngine,
  BrowserPage,
  BrowserTabs,
  CaptureRequest,
  InteractionFeedback,
  InteractionRequest,
  SurfacePlacement,
  Viewport,
} from "./engine";
import { BrowserPool, type BrowserSession } from "./pool";
import type { NativeBrowserPool } from "./native-pool";
import { inspectPage, interact } from "./inspect";
import { BrowserRendering } from "./render";
import { browserDeadline } from "./capture";

/** A tab Playwright drives: headless Chrome, or WebView2 over CDP. */
export class PlaywrightPage implements BrowserPage {
  constructor(readonly raw: Page) {
    raw.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    raw.on("download", (download) => {
      void download.cancel();
    });
  }
  url() {
    return this.raw.url();
  }
  title() {
    return this.raw.title();
  }
  isClosed() {
    return this.raw.isClosed();
  }
  async goto(url: string) {
    await this.raw.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  }
  inspect() {
    return inspectPage(this.raw);
  }
  onNavigated(listener: () => void) {
    this.raw.on("framenavigated", (frame) => {
      if (frame === this.raw.mainFrame()) listener();
    });
  }
  onLoaded(listener: () => void) {
    this.raw.on("domcontentloaded", () => listener());
  }
  onClosed(listener: () => void) {
    this.raw.on("close", () => listener());
  }
}

function playwrightPage(page: BrowserPage): Page {
  return (page as PlaywrightPage).raw;
}

async function allowBrowserAddresses(route: Route) {
  try {
    browserURL(route.request().url());
    await route.continue();
  } catch {
    await route.abort("blockedbyclient");
  }
}

abstract class PlaywrightTabs implements BrowserTabs {
  private wrapped = new WeakMap<Page, PlaywrightPage>();
  private listener?: (page: BrowserPage, replaces?: BrowserPage) => void;
  constructor(protected session: BrowserSession) {
    session.onPage?.((page, replaces) =>
      this.listener?.(this.wrap(page), replaces && this.wrap(replaces)),
    );
  }
  protected wrap(page: Page): PlaywrightPage {
    let wrapped = this.wrapped.get(page);
    if (!wrapped) {
      wrapped = new PlaywrightPage(page);
      this.wrapped.set(page, wrapped);
      this.adopted(page);
    }
    return wrapped;
  }
  /** Called once for every tab, including popups. */
  protected adopted(_page: Page) {}
  protected announce(page: Page) {
    this.listener?.(this.wrap(page));
  }
  /** Playwright reports page changes as events, so there is nothing to fetch. */
  async sync() {}
  allowOnlyBrowserAddresses() {
    return this.session.route("**/*", allowBrowserAddresses);
  }
  async newPage() {
    return this.wrap(await this.session.newPage());
  }
  onPage(listener: (page: BrowserPage, replaces?: BrowserPage) => void) {
    this.listener = listener;
  }
  close() {
    return this.session.close();
  }
  abstract interact(
    page: BrowserPage,
    request: InteractionRequest,
  ): Promise<InteractionFeedback>;
  abstract capture(page: BrowserPage, request: CaptureRequest): Promise<BrowserImage>;
  abstract resize(page: BrowserPage, viewport: Viewport, density: number): Promise<void>;
  abstract closePage(page: BrowserPage): Promise<void>;
}

class HeadlessTabs extends PlaywrightTabs {
  constructor(
    session: BrowserSession,
    private rendering: BrowserRendering,
  ) {
    super(session);
  }
  protected adopted(page: Page) {
    page.on("popup", (popup) => this.announce(popup));
  }
  interact(page: BrowserPage, request: InteractionRequest) {
    return interact(playwrightPage(page), request.input, request.viewport);
  }
  async capture(page: BrowserPage, request: CaptureRequest): Promise<BrowserImage> {
    const data = await browserDeadline(
      this.rendering.capture(
        this.session,
        playwrightPage(page),
        request.viewport,
        request.density,
        request.scale,
        request.format,
      ),
      10000,
      "Browser screenshot",
    );
    return { mimeType: `image/${request.format}`, data, ...request.viewport };
  }
  resize(page: BrowserPage, viewport: Viewport, density: number) {
    return this.rendering.resize(this.session, playwrightPage(page), viewport, density);
  }
  closePage(page: BrowserPage) {
    return playwrightPage(page).close();
  }
}

/** Cards share one hidden Chrome; the human sees its frames. */
export class HeadlessEngine implements BrowserEngine {
  readonly native = false;
  private rendering = new BrowserRendering();
  constructor(private pool = new BrowserPool()) {}
  connected() {
    return this.pool.connected();
  }
  async open(viewport: Viewport, density: number, taskId: string) {
    const tabs = new HeadlessTabs(
      await this.pool.context(viewport, density, taskId),
      this.rendering,
    );
    await tabs.allowOnlyBrowserAddresses();
    return tabs;
  }
  async surface(_taskId: string, _page: BrowserPage | undefined, _placement: SurfacePlacement) {}
  close() {
    return this.pool.close();
  }
}

class WebView2Tabs extends PlaywrightTabs {
  constructor(
    session: BrowserSession,
    private pool: NativeBrowserPool,
    private taskId: string,
  ) {
    super(session);
  }
  async interact(page: BrowserPage, request: InteractionRequest) {
    const raw = playwrightPage(page),
      worker = request.actor === "worker";
    if (worker) await this.pool.busy(this.taskId, raw, true);
    try {
      return await interact(raw, request.input, request.viewport);
    } finally {
      if (worker) await this.pool.busy(this.taskId, raw, false);
    }
  }
  async capture(page: BrowserPage, request: CaptureRequest): Promise<BrowserImage> {
    const raw = playwrightPage(page);
    const actual = await browserDeadline(
      raw.evaluate(() => ({
        viewport: { width: innerWidth, height: innerHeight },
        density: devicePixelRatio,
      })),
      3000,
      "Browser viewport observation",
    );
    // The native WebView2 capture is always PNG; only Chrome's frames change.
    const data = await this.pool.capture(
      this.taskId,
      raw,
      request.scale,
      actual.viewport,
      actual.density,
    );
    return { mimeType: "image/png", data, ...actual.viewport };
  }
  async resize() {}
  closePage(page: BrowserPage) {
    return this.pool.closePage(this.taskId, playwrightPage(page));
  }
}

/** Windows: each card's tab is a WebView2 over the card that Playwright drives over CDP. */
export class WebView2Engine implements BrowserEngine {
  readonly native = true;
  constructor(private pool: NativeBrowserPool) {}
  connected() {
    return this.pool.connected();
  }
  async open(viewport: Viewport, density: number, taskId: string) {
    const tabs = new WebView2Tabs(
      await this.pool.context(viewport, density, taskId),
      this.pool,
      taskId,
    );
    await tabs.allowOnlyBrowserAddresses();
    return tabs;
  }
  surface(taskId: string, page: BrowserPage | undefined, placement: SurfacePlacement) {
    return this.pool.surface(taskId, page && playwrightPage(page), { ...placement });
  }
  close() {
    return this.pool.close();
  }
}
