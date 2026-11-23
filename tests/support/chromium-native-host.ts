import type { Browser, BrowserContext, Page } from "playwright-core";
import type { NativeHost } from "../../runtime/host";

interface Surface {
  owner: string;
  page: Page;
  loads: number;
}

const KEYS: Record<string, string> = {
  "Shift+Tab": "Shift+Tab",
  "Control+A": "Control+A",
  "Meta+A": "Meta+A",
  Space: " ",
};

/**
 * Speaks the same methods as `src-tauri/src/browser/macos`, backed by real
 * Chrome pages, so the WebKit driver's scripts and input run against a real DOM.
 * Scripts run in the page's own world here; the Mac runs them in a separate one.
 */
export class ChromiumNativeHost implements NativeHost {
  private browser?: Browser;
  private contexts = new Map<string, BrowserContext>();
  private surfaces = new Map<string, Surface>();
  private next = 1;
  readonly inputs: any[] = [];

  async call<T>(method: string, input: any = {}): Promise<T> {
    return (await this.reply(method, input)) as T;
  }

  async close() {
    await this.browser?.close();
  }

  private async context(profile: string) {
    if (!this.browser) {
      const { chromium } = await import("playwright-core");
      let failure: unknown;
      for (const channel of ["msedge", "chrome"])
        try {
          this.browser = await chromium.launch({ channel, headless: true });
          break;
        } catch (error) {
          failure ??= error;
        }
      if (!this.browser) throw failure;
    }
    let context = this.contexts.get(profile);
    if (!context) {
      context = await this.browser.newContext({ viewport: { width: 800, height: 600 } });
      this.contexts.set(profile, context);
    }
    return context;
  }

  private owned(input: any) {
    const surface = this.surfaces.get(input.nativeId);
    if (!surface || surface.owner !== input.taskId) throw Error("Browser surface not found");
    return surface;
  }

  private async reply(method: string, input: any): Promise<unknown> {
    switch (method) {
      case "browser_create": {
        const page = await (await this.context(input.profile)).newPage();
        const nativeId = `native-${this.next++}`;
        const surface = { owner: input.taskId, page, loads: 0 };
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) surface.loads++;
        });
        this.surfaces.set(nativeId, surface);
        return { nativeId };
      }
      case "browser_pages":
        return Promise.all(
          [...this.surfaces]
            .filter(([, surface]) => surface.owner === input.taskId && !surface.page.isClosed())
            .map(async ([nativeId, surface]) => ({
              nativeId,
              opener: null,
              url: surface.page.url(),
              title: await surface.page.title().catch(() => ""),
              loading: false,
              loads: surface.loads,
            })),
        );
      case "browser_navigate":
        await this.owned(input).page.goto(input.url, { waitUntil: "load" });
        return null;
      case "browser_history": {
        const page = this.owned(input).page;
        if (input.action === "back") await page.goBack();
        else if (input.action === "forward") await page.goForward();
        else await page.reload();
        return null;
      }
      case "browser_eval":
        return this.owned(input).page.evaluate(`(async () => { ${input.script}\n})()`);
      case "browser_input":
        this.inputs.push(input.input);
        await this.deliver(this.owned(input).page, input.input);
        return null;
      case "browser_capture": {
        const page = this.owned(input).page;
        const data = await page.screenshot({ type: input.format === "jpeg" ? "jpeg" : "png" });
        return { data: data.toString("base64"), ...page.viewportSize()! };
      }
      case "browser_close":
        await this.owned(input).page.close();
        this.surfaces.delete(input.nativeId);
        return null;
      case "browser_close_task":
        for (const [id, surface] of this.surfaces)
          if (surface.owner === input.taskId) {
            await surface.page.close();
            this.surfaces.delete(id);
          }
        return null;
      case "browser_surface":
      case "browser_hide_all":
      case "browser_close_all":
        return null;
      default:
        throw Error(`Unknown browser surface operation ${method}`);
    }
  }

  private async deliver(page: Page, input: any) {
    switch (input.kind) {
      case "click":
        return page.mouse.click(input.x, input.y);
      case "move":
        return page.mouse.move(input.x, input.y);
      case "wheel":
        await page.mouse.move(input.x, input.y);
        return page.mouse.wheel(0, input.deltaY);
      case "key":
        return page.keyboard.press(KEYS[input.key] ?? input.key);
      case "text":
        return page.keyboard.insertText(input.text);
    }
  }
}
