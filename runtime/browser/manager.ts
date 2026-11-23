import { randomUUID } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { AppState } from "../../src/shared";
import {
  browserURL,
  browserRequestSchema,
  type BrowserRequest,
  type BrowserReply,
  type WorkerBrowserState,
} from "../../src/browser";
import { within, now } from "../local";
import { BrowserPool, type BrowserSession } from "./pool";
import { NativeBrowserPool } from "./native-pool";
import type { NativeHost } from "../host";
import { inspectPage, interact } from "./inspect";
import { BrowserRendering, type ImageFormat } from "./render";
import { browserDeadline } from "./capture";

interface Session {
  state: WorkerBrowserState;
  context?: BrowserSession;
  pages: Map<string, Page>;
  selected?: string;
  queue: Promise<unknown>;
  revision: number;
  observed?: { revision: string; tabId: string };
  lastViewed: number;
  log?: string;
}
export class AgentBrowserManager {
  private closing = false;
  private sessions = new Map<string, Session>();
  private pool: BrowserPool | NativeBrowserPool;
  private rendering = new BrowserRendering();
  constructor(
    private state: () => AppState,
    private dataDir: string,
    private changed: () => Promise<void>,
    private maxContexts = 16,
    host?: NativeHost,
  ) {
    this.pool =
      host && process.platform === "win32"
        ? new NativeBrowserPool(host)
        : new BrowserPool();
  }
  private session(taskId: string): Session {
    if (!this.state().tasks.some((task) => task.id === taskId))
      throw Error("Work item not found.");
    let session = this.sessions.get(taskId);
    if (!session) {
      session = {
        state: {
          taskId,
          status: "idle",
          control: "user",
          workerConnected: false,
          tabs: [],
          activity: [],
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 1,
          nativeSurface: this.pool.native,
        },
        pages: new Map(),
        queue: Promise.resolve(),
        revision: 0,
        lastViewed: Date.now(),
      };
      this.sessions.set(taskId, session);
    }
    return session;
  }
  attach(taskId: string, harness: string, directory: string): void {
    const session = this.session(taskId);
    session.state.workerConnected = true;
    session.state.harness = harness;
    session.state.control = "worker";
    session.log = join(directory, "browser-activity.jsonl");
  }
  detach(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (session) {
      session.state.workerConnected = false;
      session.state.control = "user";
    }
  }
  private async record(
    session: Session,
    actor: "user" | "worker" | "page",
    text: string,
    tabId?: string,
  ) {
    const event = { at: now(), actor, text, ...(tabId ? { tabId } : {}) };
    session.state.activity.unshift(event);
    session.state.activity.splice(40);
    if (session.log)
      await appendFile(session.log, JSON.stringify(event) + "\n", {
        mode: 0o600,
      });
  }
  private view(session: Session): WorkerBrowserState {
    session.state.tabs = [...session.pages]
      .filter(([, page]) => !page.isClosed())
      .map(([id, page]) => ({
        id,
        url: page.url(),
        title:
          session.state.tabs.find((tab) => tab.id === id)?.title ?? "New tab",
        active: id === session.selected,
      }));
    return structuredClone(session.state);
  }
  private register(session: Session, page: Page, replaces?: Page): string {
    const previous = [...session.pages].find(
      ([, existing]) => existing === page,
    );
    if (previous) return previous[0];
    const replacing = [...session.pages].find(
      ([, existing]) => existing === replaces,
    );
    const id = replacing?.[0] ?? randomUUID();
    session.pages.set(id, page);
    if (!replacing) session.selected = id;
    session.state.pointer = undefined;
    session.state.cursor = undefined;
    session.revision++;
    session.observed = undefined;
    const update = () => {
      void page
        .title()
        .then((title) => {
          const tab = session.state.tabs.find((tab) => tab.id === id);
          if (tab && session.pages.get(id) === page)
            tab.title = title || "New tab";
        })
        .catch(() => {});
    };
    page.on("domcontentloaded", update);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || session.pages.get(id) !== page) return;
      session.revision++;
      session.observed = undefined;
      update();
      void this.record(session, "page", "Navigated to " + page.url(), id).catch(
        () => {},
      );
    });
    if (!this.pool.native)
      page.on("popup", (popup) => this.register(session, popup));
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    page.on("download", (download) => {
      void download.cancel();
    });
    page.on("close", () => {
      if (session.pages.get(id) !== page) return;
      session.pages.delete(id);
      if (session.selected === id)
        session.selected = session.pages.keys().next().value;
    });
    if (!replacing)
      session.state.tabs.push({
        id,
        title: "New tab",
        url: page.url(),
        active: true,
      });
    update();
    return id;
  }
  private async context(session: Session): Promise<BrowserSession> {
    if (session.context && this.pool.connected()) return session.context;
    const occupied = [...this.sessions.values()].filter(
      (other) =>
        (other.context && this.pool.connected()) ||
        other.state.status === "starting",
    );
    if (occupied.length >= this.maxContexts) {
      const idle = occupied
        .filter(
          (other) =>
            !other.state.workerConnected &&
            other !== session &&
            Date.now() - other.lastViewed > 30000,
        )
        .sort((a, b) => a.lastViewed - b.lastViewed)[0];
      if (!idle)
        throw Error(
          "The live browser sessions are all in use. Close an idle browser tab or wait for a worker to finish.",
        );
      await idle.context?.close();
      idle.context = undefined;
      idle.pages.clear();
      idle.state.status = "idle";
      await this.record(
        idle,
        "page",
        "Idle browser released; reopen the page to continue.",
      );
    }
    session.state.status = "starting";
    session.context = await this.pool.context(
      session.state.viewport,
      session.state.deviceScaleFactor,
      session.state.taskId,
    );
    await session.context.route("**/*", async (route) => {
      try {
        browserURL(route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    session.context.onPage?.((page, replaces) =>
      this.register(session, page, replaces),
    );
    session.pages.clear();
    session.selected = undefined;
    return session.context;
  }
  private page(session: Session, tabId?: string): Page {
    const page = session.pages.get(tabId ?? session.selected ?? "");
    if (!page || page.isClosed())
      throw Error("Open a browser tab in this work item first.");
    return page;
  }
  async execute(
    taskId: string,
    input: BrowserRequest,
    actor: "user" | "worker" = "user",
  ): Promise<BrowserReply> {
    if (this.closing) throw Error("The browser service is closing.");
    const request = browserRequestSchema.parse(input),
      session = this.session(taskId);
    if (
      actor === "worker" &&
      !["open", "observe", "act"].includes(request.action)
    )
      throw Error("This browser operation belongs to the MemCode application.");
    if (actor === "user") session.lastViewed = Date.now();
    if (request.action === "state") return { state: this.view(session) };
    const operation = session.queue
      .catch(() => {})
      .then(async () => {
        try {
          if (this.closing) throw Error("The browser service is closing.");
          return await this.perform(session, request, actor);
        } catch (error) {
          session.state.error = String(
            error instanceof Error ? error.message : error,
          );
          session.state.action = undefined;
          session.state.status = session.pages.size ? "ready" : "error";
          throw error;
        }
      });
    session.queue = operation;
    return operation;
  }
  private async perform(
    session: Session,
    request: BrowserRequest,
    actor: "user" | "worker",
  ): Promise<BrowserReply> {
    const observing = ["state", "frame", "observe"].includes(request.action);
    if (actor === "worker" && !observing && session.state.control === "user")
      throw Error(
        "The user has browser control. Wait for them to return control before taking another browser action.",
      );
    if (!observing && !["surface", "control"].includes(request.action))
      session.state.error = undefined;
    if (request.action === "control") {
      session.state.control = request.value;
      session.revision++;
      session.observed = undefined;
      await this.record(
        session,
        actor,
        request.value === "user"
          ? "User took browser control."
          : "Browser returned to the worker.",
      );
    } else if (request.action === "surface") {
      if (this.pool instanceof NativeBrowserPool) {
        const page = request.tabId
          ? this.page(session, request.tabId)
          : undefined;
        await this.pool.surface(session.state.taskId, page, {
          visible: request.visible,
          bounds: request.bounds,
        });
        if (request.visible && request.bounds)
          session.state.viewport = {
            width: Math.round(request.bounds.width),
            height: Math.round(request.bounds.height),
          };
      }
    } else if (request.action === "new-tab") {
      const context = await this.context(session);
      const id = this.register(session, await context.newPage());
      session.state.status = "ready";
      session.state.cursor = undefined;
      session.state.pointer = undefined;
      await this.record(session, actor, "Created a browser tab.", id);
    } else if (request.action === "open") {
      const url = browserURL(request.url);
      session.state.action = "Opening " + url.hostname;
      const context = await this.context(session);
      const existing =
        actor === "user" && !request.tabId
          ? [...session.pages].find(
              ([, page]) => !page.isClosed() && page.url() === url.href,
            )
          : undefined;
      const page = request.tabId
        ? this.page(session, request.tabId)
        : (existing?.[1] ?? (await context.newPage()));
      const id = request.tabId ?? existing?.[0] ?? this.register(session, page);
      session.selected = id;
      if (!existing)
        await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
      session.state.status = "ready";
      this.view(session);
      session.state.tabs.find((tab) => tab.id === id)!.title =
        await page.title();
      await this.record(session, actor, "Opened " + page.url(), id);
    } else if (request.action === "act") {
      const command = request.input,
        page = this.page(session, command.tabId);
      if (
        actor === "worker" &&
        ["click", "type", "choose", "press", "scroll", "hover"].includes(
          command.action,
        ) &&
        (!command.revision ||
          command.revision !== session.observed?.revision ||
          page !== session.pages.get(session.observed?.tabId ?? "") ||
          command.revision !== String(session.revision))
      )
        throw Error(
          "The page changed since that observation. Observe the current page before acting.",
        );
      if (command.action === "capture") return this.capture(session, actor);
      if (
        command.action === "hover" &&
        actor === "user" &&
        session.state.workerConnected &&
        session.state.control === "worker"
      )
        return { state: this.view(session) };
      if (actor === "worker" && command.tabId) session.selected = command.tabId;
      if (command.action === "select") {
        if (!command.tabId || command.ref)
          throw Error(
            "Select switches a browser tab by tabId. Use choose with a control ref and option value or label for an HTML select.",
          );
        session.selected = command.tabId;
        session.state.pointer = undefined;
        session.state.cursor = undefined;
      } else if (command.action === "close") {
        if (this.pool instanceof NativeBrowserPool)
          await this.pool.closePage(session.state.taskId, page);
        else await page.close();
        if (!session.pages.size) {
          await session.context?.close();
          session.context = undefined;
          session.state.status = "idle";
        }
      } else {
        session.state.action = command.action;
        const native =
          this.pool instanceof NativeBrowserPool ? this.pool : undefined;
        if (native && actor === "worker")
          await native.busy(session.state.taskId, page, true);
        let feedback;
        try {
          feedback = await interact(page, command, session.state.viewport);
        } finally {
          if (native && actor === "worker")
            await native.busy(session.state.taskId, page, false);
        }
        if (
          feedback.cursor &&
          page === session.pages.get(session.selected ?? "")
        )
          session.state.cursor = feedback.cursor;
        if (
          feedback.point &&
          page === session.pages.get(session.selected ?? "")
        )
          session.state.pointer = { ...feedback.point, actor, at: Date.now() };
      }
      session.revision++;
      session.observed = undefined;
      if (command.action !== "hover" || actor === "worker")
        await this.record(
          session,
          actor,
          `Browser ${command.action}${command.ref ? " on " + command.ref : ""}`,
          command.tabId ?? session.selected,
        );
    } else if (request.action === "resize") {
      session.state.viewport = { width: request.width, height: request.height };
      session.state.deviceScaleFactor =
        request.deviceScaleFactor ?? session.state.deviceScaleFactor;
      for (const page of this.pool.native ? [] : session.pages.values())
        await this.rendering.resize(
          session.context!,
          page,
          session.state.viewport,
          session.state.deviceScaleFactor,
        );
      session.revision++;
      session.observed = undefined;
    } else if (request.action === "observe") {
      const page = this.page(session, request.tabId);
      const tabId = request.tabId ?? session.selected!;
      if (actor === "worker" && session.state.control === "worker")
        session.selected = tabId;
      const text = await browserDeadline(
        inspectPage(page),
        10000,
        "Browser DOM observation",
      );
      session.observed = { revision: String(session.revision), tabId };
      await this.record(
        session,
        actor,
        "Observed " + page.url(),
        request.tabId ?? session.selected,
      );
      let image;
      if (request.screenshot) {
        try {
          image = await this.image(session, page, "css");
          if (session.state.error?.startsWith("Screenshot unavailable:"))
            session.state.error = undefined;
        } catch (error) {
          session.state.error =
            "Screenshot unavailable: " +
            (error instanceof Error ? error.message : String(error));
          await this.record(session, actor, session.state.error, tabId);
        }
      }
      return {
        state: this.view(session),
        snapshot: { revision: session.observed.revision, text },
        ...(image ? { image } : {}),
      };
    } else if (request.action === "frame") {
      const page = session.pages.size ? this.page(session) : undefined;
      return {
        state: this.view(session),
        ...(page && page.url() !== "about:blank"
          ? { image: await this.image(session, page, "device", "jpeg") }
          : {}),
      };
    } else if (request.action === "capture")
      return this.capture(session, actor);
    session.state.action = undefined;
    return { state: this.view(session) };
  }
  private async image(
    session: Session,
    page: Page,
    scale: "css" | "device",
    format: ImageFormat = "png",
  ) {
    const actual = this.pool.native
      ? await browserDeadline(
          page.evaluate(() => ({
            viewport: { width: innerWidth, height: innerHeight },
            density: devicePixelRatio,
          })),
          3000,
          "Browser viewport observation",
        )
      : undefined;
    // The native WebView2 capture is always PNG; only Chrome's frames change.
    const encoded =
      this.pool instanceof NativeBrowserPool
        ? {
            format: "png" as const,
            data: await this.pool.capture(
              session.state.taskId,
              page,
              scale,
              actual!.viewport,
              actual!.density,
            ),
          }
        : {
            format,
            data: await browserDeadline(
              this.rendering.capture(
                session.context!,
                page,
                actual?.viewport ?? session.state.viewport,
                actual?.density ?? session.state.deviceScaleFactor,
                scale,
                format,
              ),
              10000,
              "Browser screenshot",
            ),
          };
    return {
      mimeType: `image/${encoded.format}` as const,
      data: encoded.data,
      ...(actual?.viewport ?? session.state.viewport),
    };
  }
  private async capture(
    session: Session,
    actor: "user" | "worker",
  ): Promise<BrowserReply> {
    const page = this.page(session),
      image = await this.image(session, page, "device");
    const task = this.state().tasks.find(
      (task) => task.id === session.state.taskId,
    )!;
    const root = join(this.dataDir, "captures", task.id);
    if (!within(join(this.dataDir, "captures"), root))
      throw Error("Invalid browser capture owner.");
    await mkdir(root, { recursive: true });
    const name = `browser-${now().replace(/[:.]/g, "-")}.png`,
      path = join(root, name),
      id = randomUUID();
    await writeFile(path, Buffer.from(image.data, "base64"));
    this.state().artifacts.push({
      id,
      name,
      kind: "image",
      path,
      taskId: task.id,
      projectId: task.projectId,
      createdAt: now(),
      source: `Worker browser · ${await page.title()}`,
    });
    await this.changed();
    await this.record(session, actor, "Saved browser screenshot.");
    return { state: this.view(session), artifactId: id };
  }
  async close(): Promise<void> {
    this.closing = true;
    // Closing Chromium cancels pending navigation and screenshot operations.
    await this.pool.close();
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.queue),
    );
  }
}
