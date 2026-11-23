import type { BrowserInteraction } from "../../src/browser";
import type { InteractionFeedback, InteractionRequest, Viewport } from "./engine";
import { ACCESSIBILITY_TREE } from "./webkit-accessibility";

export type NativeInput =
  | { kind: "click" | "move"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaY: number }
  | { kind: "key"; key: string }
  | { kind: "text"; text: string };

/** What the WebKit driver needs from one native tab. */
export interface NativeScripts {
  url(): string;
  title(): Promise<string>;
  /** Runs an async function body in MemCode's content world; it returns text. */
  run(script: string): Promise<string>;
  input(input: NativeInput): Promise<unknown>;
  travel(action: "back" | "forward" | "reload"): Promise<void>;
}

type Point = { x: number; y: number };
type Echo = "mouseup" | "mousemove" | "keyup" | "input" | "wheel";

const MAX_OBSERVATION = 18000;
const ECHO_TIMEOUT_MS = 1500;
const ECHO_POLL_MS = 15;
const SETTLE_TIMEOUT_MS = 8000;
const SETTLE_POLL_MS = 100;
const DEFAULT_SCROLL = 600;
const KNOWN_CURSORS = [
  "default",
  "auto",
  "pointer",
  "text",
  "crosshair",
  "grab",
  "grabbing",
  "not-allowed",
  "wait",
  "progress",
];

/** Same refs and wording as `inspectPage`, so a worker sees one format everywhere. */
const TAG_CONTROLS = `
for (const node of document.querySelectorAll("[data-memcode-ref]"))
  node.removeAttribute("data-memcode-ref");
const nodes = [...document.querySelectorAll(
  "a,button,input,textarea,select,[role=button],[contenteditable=true]",
)]
  .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
  .slice(0, 100);
return nodes
  .map((node, index) => {
    const ref = "m" + (index + 1);
    node.setAttribute("data-memcode-ref", ref);
    return (ref + ": " + node.tagName.toLowerCase() + " " + (node.getAttribute("aria-label") || node.innerText || node.getAttribute("placeholder") || node.getAttribute("name") || "")).slice(0, 220);
  })
  .join("\\n");
`;

/**
 * Counts the trusted events the page has received, per type. A fresh document
 * starts a fresh count, which tells the driver the page moved on.
 */
const ECHO_COUNTER = `
const fresh = !globalThis.__memcodeEchoes;
const echoes = (globalThis.__memcodeEchoes ??= (() => {
  const seen = { mouseup: 0, mousemove: 0, keyup: 0, input: 0, wheel: 0 };
  for (const type of Object.keys(seen))
    addEventListener(type, (event) => { if (event.isTrusted) seen[type]++; }, { capture: true, passive: true });
  return seen;
})());
`;

/** Controls WebKit answers with an AppKit menu or panel instead of the page. */
const PICKER_CHECK = `
const pickers = { file: "Choosing files needs the user: ask them to pick the file.",
  date: "Set dates with type instead of the picker.", "datetime-local": "Set dates with type instead of the picker.",
  month: "Set dates with type instead of the picker.", week: "Set dates with type instead of the picker.",
  time: "Set times with type instead of the picker.", color: "Set colors with type instead of the picker." };
const refusal = (element) => {
  const control = element && element.closest ? element.closest("select, input") : null;
  if (!control) return undefined;
  if (control.tagName === "SELECT")
    return "Use choose with a control ref and option value or label for an HTML select.";
  return pickers[(control.getAttribute("type") || "").toLowerCase()];
};
`;

function script(body: string, args: Record<string, unknown> = {}) {
  return `const args = ${JSON.stringify(args)};\n${body}`;
}

async function runJson<T>(page: NativeScripts, body: string, args: Record<string, unknown> = {}) {
  return JSON.parse(await page.run(script(body, args))) as T;
}

function failure(result: { error?: string }) {
  if (result.error) throw Error(result.error);
}

export async function inspectNativePage(page: NativeScripts): Promise<string> {
  const references = await page.run(TAG_CONTROLS);
  const accessible = await page
    .run(ACCESSIBILITY_TREE)
    .catch(() => "Accessibility snapshot unavailable.");
  return `URL: ${page.url()}\nTitle: ${await page.title()}\n\nVisible controls (use ref for actions):\n${references}\n\nAccessibility:\n${accessible}`.slice(
    0,
    MAX_OBSERVATION,
  );
}

/** Delivers one input and waits until the page has seen it, or a new page loaded. */
async function deliver(page: NativeScripts, input: NativeInput, echo: Echo) {
  const before = await runJson<{ count: number }>(
    page,
    `${ECHO_COUNTER} return JSON.stringify({ count: echoes[args.echo] });`,
    { echo },
  );
  await page.input(input);
  const deadline = Date.now() + ECHO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const after = await runJson<{ count: number; fresh: boolean }>(
      page,
      `${ECHO_COUNTER} return JSON.stringify({ count: echoes[args.echo], fresh });`,
      { echo },
    ).catch(() => ({ count: before.count, fresh: true }));
    if (after.fresh || after.count > before.count) return;
    await new Promise((resolve) => setTimeout(resolve, ECHO_POLL_MS));
  }
}

/** Scrolls a control into view and finds a point on it that receives the click. */
async function target(page: NativeScripts, ref: string): Promise<Point> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const found = await runJson<Point & { error?: string; retry?: boolean }>(
      page,
      `${PICKER_CHECK}
      const element = document.querySelector('[data-memcode-ref="' + args.ref + '"]');
      if (!element) return JSON.stringify({ error: "That control is gone. Observe the page again." });
      const refused = refusal(element);
      if (refused) return JSON.stringify({ error: refused });
      const view = () => element.getBoundingClientRect();
      let rect = view();
      if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        rect = view();
      }
      if (!rect.width || !rect.height || getComputedStyle(element).visibility === "hidden")
        return JSON.stringify({ retry: true, error: "That control is not visible." });
      if (element.disabled) return JSON.stringify({ retry: true, error: "That control is disabled." });
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      const receives = hit && (hit === element || element.contains(hit) || (hit.control === element));
      if (!receives) {
        const cover = hit ? hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") : "nothing";
        return JSON.stringify({ retry: true, error: "Another element (" + cover + ") covers that control. Close it or observe again." });
      }
      return JSON.stringify({ x, y });`,
      { ref },
    );
    if (!found.error) return { x: found.x, y: found.y };
    if (!found.retry || Date.now() > deadline) failure(found);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

async function refusePickerAt(page: NativeScripts, point: Point) {
  failure(
    await runJson<{ error?: string }>(
      page,
      `${PICKER_CHECK} return JSON.stringify({ error: refusal(document.elementFromPoint(args.x, args.y)) });`,
      point,
    ),
  );
}

function inside(point: Point | undefined, viewport: Viewport): point is Point {
  return !!point && point.x <= viewport.width && point.y <= viewport.height;
}

function pointOf(input: BrowserInteraction): Point | undefined {
  return input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined;
}

async function click(page: NativeScripts, input: BrowserInteraction, viewport: Viewport) {
  let point = pointOf(input);
  if (input.ref) point = await target(page, input.ref);
  else if (!inside(point, viewport))
    throw Error("Choose a current control ref or a point inside this page.");
  else await refusePickerAt(page, point);
  await deliver(page, { kind: "click", ...point! }, "mouseup");
  return point;
}

/** Focuses the field and selects what is in it, so typing replaces it like Playwright's fill. */
async function type(page: NativeScripts, input: BrowserInteraction) {
  if (input.text === undefined) throw Error("Text is required.");
  if (!input.ref) {
    if (input.text) await deliver(page, { kind: "text", text: input.text }, "input");
    return;
  }
  const field = await runJson<{ error?: string; set?: boolean; empty?: boolean }>(
    page,
    `const element = document.querySelector('[data-memcode-ref="' + args.ref + '"]');
    if (!element) return JSON.stringify({ error: "That control is gone. Observe the page again." });
    const kind = (element.getAttribute("type") || "").toLowerCase();
    const picked = ["date", "datetime-local", "month", "week", "time", "color", "range"].includes(kind);
    if (element.tagName === "INPUT" && picked) {
      element.focus();
      element.value = args.text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return JSON.stringify({ set: true });
    }
    const editable = element.isContentEditable || ["INPUT", "TEXTAREA"].includes(element.tagName);
    if (!editable) return JSON.stringify({ error: "That control does not take text." });
    if (element.disabled || element.readOnly) return JSON.stringify({ error: "That field is read-only." });
    element.scrollIntoView({ block: "center", behavior: "instant" });
    element.focus();
    if (element.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(element);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return JSON.stringify({ empty: !element.textContent });
    }
    try { element.select(); } catch {}
    return JSON.stringify({ empty: !element.value });`,
    { ref: input.ref, text: input.text },
  );
  failure(field);
  if (field.set) return;
  if (input.text) await deliver(page, { kind: "text", text: input.text }, "input");
  else if (!field.empty) await deliver(page, { kind: "key", key: "Backspace" }, "keyup");
}

/** As Playwright's selectOption: sets the option and fires input and change. */
async function choose(page: NativeScripts, input: BrowserInteraction) {
  if (!input.ref || (input.value === undefined && input.label === undefined))
    throw Error("Choose a current select ref and option value or label.");
  failure(
    await runJson<{ error?: string }>(
      page,
      `const element = document.querySelector('[data-memcode-ref="' + args.ref + '"]');
      if (!element) return JSON.stringify({ error: "That control is gone. Observe the page again." });
      if (element.tagName !== "SELECT") return JSON.stringify({ error: "Choose works on an HTML select." });
      const option = [...element.options].find((option) =>
        args.value !== null ? option.value === args.value : option.label === args.label || option.textContent.trim() === args.label);
      if (!option) return JSON.stringify({ error: "That select has no such option." });
      if (option.disabled) return JSON.stringify({ error: "That option is disabled." });
      element.value = option.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return JSON.stringify({});`,
      { ref: input.ref, value: input.value ?? null, label: input.label ?? null },
    ),
  );
}

async function cursorAt(page: NativeScripts, point: Point) {
  const cursor = await page
    .run(
      script(
        `const element = document.elementFromPoint(args.x, args.y);
        if (!element) return "default";
        if (element.closest("input,textarea,[contenteditable=true]")) return "text";
        return getComputedStyle(element).cursor;`,
        point,
      ),
    )
    .catch(() => "default");
  return KNOWN_CURSORS.includes(cursor) ? cursor : "default";
}

export async function interactNatively(
  page: NativeScripts,
  request: InteractionRequest,
): Promise<InteractionFeedback> {
  const { input, viewport } = request;
  let point = pointOf(input);
  switch (input.action) {
    case "back":
    case "forward":
    case "reload":
      await page.travel(input.action);
      return {};
    case "click":
      point = await click(page, input, viewport);
      break;
    case "hover":
      if (!inside(point, viewport)) throw Error("Hover inside the current page.");
      await deliver(page, { kind: "move", ...point }, "mousemove");
      break;
    case "type":
      await type(page, input);
      break;
    case "press":
      if (!input.key) throw Error("A supported key is required.");
      await deliver(page, { kind: "key", key: input.key }, "keyup");
      break;
    case "choose":
      await choose(page, input);
      break;
    case "scroll": {
      const at = point ?? { x: viewport.width / 2, y: viewport.height / 2 };
      await deliver(page, { kind: "wheel", ...at, deltaY: input.deltaY ?? DEFAULT_SCROLL }, "wheel");
      break;
    }
    default:
      throw Error(`The browser cannot ${input.action} here.`);
  }
  if (!point) return {};
  return { point, cursor: await cursorAt(page, point) };
}
