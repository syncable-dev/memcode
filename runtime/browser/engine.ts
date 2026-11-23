import type { BrowserInteraction, BrowserImage } from "../../src/browser";

export type ImageFormat = "png" | "jpeg";
export type ImageScale = "css" | "device";
export interface Viewport {
  width: number;
  height: number;
}
export interface InteractionRequest {
  input: BrowserInteraction;
  viewport: Viewport;
  actor: "user" | "worker";
}
export interface InteractionFeedback {
  cursor?: string;
  point?: { x: number; y: number };
}
export interface CaptureRequest {
  scale: ImageScale;
  format: ImageFormat;
  /** The card's own viewport, for engines that cannot ask the page. */
  viewport: Viewport;
  density: number;
}
export interface SurfacePlacement {
  visible: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

/** One tab of a card's browser, whichever engine draws it. */
export interface BrowserPage {
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  goto(url: string): Promise<void>;
  /** The worker's text view: control refs plus the accessibility tree. */
  inspect(): Promise<string>;
  onNavigated(listener: () => void): void;
  onLoaded(listener: () => void): void;
  onClosed(listener: () => void): void;
}

/** A card's browser: its own storage, its tabs and the popups they open. */
export interface BrowserTabs {
  newPage(): Promise<BrowserPage>;
  onPage(listener: (page: BrowserPage, replaces?: BrowserPage) => void): void;
  interact(page: BrowserPage, request: InteractionRequest): Promise<InteractionFeedback>;
  capture(page: BrowserPage, request: CaptureRequest): Promise<BrowserImage>;
  resize(page: BrowserPage, viewport: Viewport, density: number): Promise<void>;
  closePage(page: BrowserPage): Promise<void>;
  close(): Promise<void>;
}

/** Where card browsers live: hidden Chrome frames or a native surface over the card. */
export interface BrowserEngine {
  /** True when the human sees a live native surface instead of frames. */
  readonly native: boolean;
  connected(): boolean;
  open(viewport: Viewport, density: number, taskId: string): Promise<BrowserTabs>;
  /** Places, shows or hides the native surface over the card; frame engines ignore it. */
  surface(taskId: string, page: BrowserPage | undefined, placement: SurfacePlacement): Promise<void>;
  close(): Promise<void>;
}
