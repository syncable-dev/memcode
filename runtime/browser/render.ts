import type { CDPSession, Page } from "playwright-core";
import type { BrowserSession } from "./pool";

export type ImageFormat = "png" | "jpeg";
// At Retina density Chrome encodes this 2-3x faster than PNG at about a third
// of the size; 90 approaches PNG size on text-heavy pages.
const JPEG_QUALITY = 85;

export class BrowserRendering {
  private sessions = new WeakMap<Page, CDPSession>();
  private async session(context: BrowserSession, page: Page) {
    let session = this.sessions.get(page);
    if (!session) {
      session = await context.newCDPSession(page);
      this.sessions.set(page, session);
    }
    return session;
  }
  async resize(
    context: BrowserSession,
    page: Page,
    viewport: { width: number; height: number },
    deviceScaleFactor: number,
  ) {
    await page.setViewportSize(viewport);
    const session = await this.session(context, page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor,
      mobile: false,
    });
  }
  async capture(
    context: BrowserSession,
    page: Page,
    viewport: { width: number; height: number },
    deviceScaleFactor: number,
    scale: "css" | "device",
    format: ImageFormat = "png",
  ): Promise<string> {
    const session = await this.session(context, page);
    // Capture the compositor at its actual density. Playwright's screenshot
    // helper otherwise rescales using the context's original density after a
    // display change. CDP also preserves the page's native caret and selection.
    // The clip is in page coordinates, so it starts where the page is scrolled.
    const { cssVisualViewport: visible } = await session.send(
      "Page.getLayoutMetrics",
    );
    const result = await session.send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: JPEG_QUALITY } : {}),
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: visible.pageX,
        y: visible.pageY,
        ...viewport,
        scale: scale === "css" ? 1 / deviceScaleFactor : 1,
      },
    });
    return result.data;
  }
}
