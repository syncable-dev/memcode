import type { InteractionFeedback, InteractionRequest } from "./engine";

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

const MAX_OBSERVATION = 18000;

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

export async function inspectNativePage(page: NativeScripts): Promise<string> {
  const references = await page.run(TAG_CONTROLS);
  return `URL: ${page.url()}\nTitle: ${await page.title()}\n\nVisible controls (use ref for actions):\n${references}`.slice(
    0,
    MAX_OBSERVATION,
  );
}

export async function interactNatively(
  page: NativeScripts,
  request: InteractionRequest,
): Promise<InteractionFeedback> {
  const action = request.input.action;
  if (action === "back" || action === "forward" || action === "reload") {
    await page.travel(action);
    return {};
  }
  throw Error(`The Mac browser cannot ${action} for a worker yet.`);
}
