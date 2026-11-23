/**
 * The page's accessibility tree for a worker, written like Playwright's aria
 * snapshot (`- role "name" [state]: value`) so observations read the same on
 * every platform. Runs as an async function body in MemCode's content world.
 */
export const ACCESSIBILITY_TREE = `
const MAX_LINES = 500, MAX_NODES = 6000, MAX_TEXT = 160;
const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
const FROM_CONTENT = new Set(["button", "link", "heading", "option", "tab", "menuitem", "cell", "columnheader", "rowheader", "treeitem", "checkbox", "radio", "switch"]);
const TEXT_LEAF = new Set(["listitem", "paragraph", "cell", "columnheader", "rowheader", "status", "caption", "blockquote", "code", "term", "definition"]);
const VALUED = new Set(["textbox", "searchbox", "spinbutton", "slider", "combobox"]);
const lines = [];
let visited = 0;
const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
const clip = (text) => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text);
const quote = (text) => JSON.stringify(clip(text));

function hidden(element) {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
  const style = getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}

function inputRole(element) {
  const type = (element.getAttribute("type") || "text").toLowerCase();
  if (type === "hidden") return "";
  if (["button", "submit", "reset", "image"].includes(type)) return "button";
  if (type === "checkbox") return element.getAttribute("role") === "switch" ? "switch" : "checkbox";
  if (type === "radio") return "radio";
  if (type === "range") return "slider";
  if (type === "number") return "spinbutton";
  if (type === "search") return "searchbox";
  return element.list ? "combobox" : "textbox";
}

function role(element) {
  const explicit = clean(element.getAttribute("role")).split(" ")[0];
  if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
  if (explicit) return "";
  const tag = element.tagName;
  if (/^H[1-6]$/.test(tag)) return "heading";
  switch (tag) {
    case "A": return element.hasAttribute("href") ? "link" : "";
    case "BUTTON": case "SUMMARY": return "button";
    case "INPUT": return inputRole(element);
    case "TEXTAREA": return "textbox";
    case "SELECT": return element.multiple || element.size > 1 ? "listbox" : "combobox";
    case "OPTION": return "option";
    case "IMG": return element.getAttribute("alt") === "" ? "" : "img";
    case "UL": case "OL": case "MENU": return "list";
    case "LI": return "listitem";
    case "NAV": return "navigation";
    case "MAIN": return "main";
    case "ASIDE": return "complementary";
    case "HEADER": return element.closest("article, section, main") ? "" : "banner";
    case "FOOTER": return element.closest("article, section, main") ? "" : "contentinfo";
    case "FORM": return element.getAttribute("aria-label") || element.getAttribute("name") ? "form" : "";
    case "TABLE": return "table";
    case "TR": return "row";
    case "TH": return "columnheader";
    case "TD": return "cell";
    case "DIALOG": return "dialog";
    case "P": return "paragraph";
    case "OUTPUT": return "status";
    case "PROGRESS": return "progressbar";
    case "IFRAME": return "iframe";
    case "BLOCKQUOTE": return "blockquote";
    case "CODE": return "code";
    case "DT": return "term";
    case "DD": return "definition";
    case "FIGCAPTION": case "CAPTION": return "caption";
  }
  return "";
}

function visibleText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE || SKIPPED.has(node.tagName) || hidden(node)) return "";
  if (node.tagName === "IMG") return node.getAttribute("alt") || "";
  return [...node.childNodes].map(visibleText).join(node.tagName === "BR" ? " " : "");
}

function labelOf(element) {
  if (element.labels && element.labels.length)
    return clean([...element.labels].map((label) =>
      [...label.childNodes].filter((child) => child !== element && !(child.contains && child.contains(element))).map(visibleText).join(" ")).join(" "));
  return "";
}

function name(element, kind) {
  const labelledBy = clean(element.getAttribute("aria-labelledby"));
  if (labelledBy) {
    const text = clean(labelledBy.split(" ").map((id) => { const target = document.getElementById(id); return target ? visibleText(target) : ""; }).join(" "));
    if (text) return text;
  }
  const label = clean(element.getAttribute("aria-label"));
  if (label) return label;
  if (["INPUT", "TEXTAREA", "SELECT", "METER", "PROGRESS"].includes(element.tagName)) {
    const labelled = labelOf(element);
    if (labelled) return labelled;
  }
  if (element.tagName === "IMG") return clean(element.getAttribute("alt") || element.getAttribute("title"));
  if (element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type))
    return clean(element.value || (element.type === "submit" ? "Submit" : ""));
  if (element.tagName === "IFRAME") return clean(element.getAttribute("title"));
  if (FROM_CONTENT.has(kind)) {
    const text = clean(element.tagName === "OPTION" ? element.label : visibleText(element));
    if (text) return text;
  }
  return clean(element.getAttribute("title") || element.getAttribute("placeholder"));
}

function states(element, kind) {
  const flags = [];
  if (kind === "heading") flags.push("level=" + (element.getAttribute("aria-level") || element.tagName.slice(1)));
  const checked = element.getAttribute("aria-checked");
  if (checked === "true" || (checked === null && element.checked)) flags.push("checked");
  if (checked === "mixed" || element.indeterminate) flags.push("checked=mixed");
  if (element.getAttribute("aria-selected") === "true" || (kind === "option" && element.selected)) flags.push("selected");
  if (element.getAttribute("aria-expanded")) flags.push("expanded=" + element.getAttribute("aria-expanded"));
  if (element.getAttribute("aria-pressed") === "true") flags.push("pressed");
  if (element.disabled || element.getAttribute("aria-disabled") === "true") flags.push("disabled");
  return flags.map((flag) => " [" + flag + "]").join("");
}

function value(element, kind) {
  if (!VALUED.has(kind)) return "";
  if (element.tagName === "SELECT") return "";
  if ("value" in element) return clean(element.value);
  return clean(element.textContent);
}

function emit(depth, text) {
  if (lines.length < MAX_LINES) lines.push("  ".repeat(depth) + "- " + text);
}

/** Element and text children as they will be shown, flattening unnamed containers. */
function walk(node, depth) {
  if (lines.length >= MAX_LINES || ++visited > MAX_NODES) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = clean(node.textContent);
    if (text) emit(depth, "text: " + clip(text));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || SKIPPED.has(node.tagName) || hidden(node)) return;
  const kind = role(node);
  if (!kind) {
    for (const child of node.childNodes) walk(child, depth);
    return;
  }
  const label = name(node, kind);
  const head = kind + (label ? " " + quote(label) : "") + states(node, kind);
  const shown = value(node, kind);
  if (shown) return emit(depth, head + ": " + clip(shown));
  if (FROM_CONTENT.has(kind) && !hasRoles(node)) return emit(depth, head);
  if (TEXT_LEAF.has(kind) && !hasRoles(node)) {
    const text = clean(visibleText(node));
    return emit(depth, text ? head + ": " + clip(text) : head);
  }
  const before = lines.length;
  emit(depth, head + ":");
  for (const child of node.childNodes) walk(child, depth + 1);
  if (lines.length === before + 1) lines[before] = lines[before].slice(0, -1);
}

function hasRoles(element) {
  for (const child of element.querySelectorAll("*")) if (role(child) && !hidden(child)) return true;
  return false;
}

walk(document.body, 0);
if (lines.length >= MAX_LINES || visited > MAX_NODES) lines.push("- …");
return lines.join("\\n");
`;
