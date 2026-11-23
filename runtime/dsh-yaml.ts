/** Set on a value that is itself tagged `!!js`, or that contains one that is. */
const JS_EXPR = Symbol("dsh.jsExpression");
/** Set only on a collection that carries an explicit `!!js` tag of its own. */
const JS_EXPLICIT = Symbol("dsh.jsExplicitTag");

function markJsExpr<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.defineProperty(value, JS_EXPR, { value: true, enumerable: false, configurable: true });
  }
  return value;
}

function markExplicitJs<T>(value: T): T {
  if (value && typeof value === "object") {
    markJsExpr(value);
    Object.defineProperty(value, JS_EXPLICIT, { value: true, enumerable: false, configurable: true });
  }
  return value;
}

export function hasJsTag(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as Record<symbol, unknown>)[JS_EXPR] === true) return true;
  if (Array.isArray(value)) return value.some((item) => hasJsTag(item));
  return Object.values(value).some((item) => hasJsTag(item));
}

/**
 * Whether this collection itself was written with an explicit `!!js` tag.
 * Unlike {@link hasJsTag}, a marker propagated from a tagged descendant does
 * not count, so safe siblings of a tagged value stay distinguishable.
 */
export function hasExplicitJsTag(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[JS_EXPLICIT] === true
  );
}

const SECRET_VALUE_RE = /^(?:Bearer|Basic)\s+\S+/i;
const SECRET_HEAD_WORDS = new Set([
  "secret",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "token",
  "authorization",
  "auth",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "apikey",
  "privatekey",
]);
const SECRET_KEY_QUALIFIERS = new Set([
  "api",
  "private",
  "access",
  "secret",
  "signing",
  "session",
  "encryption",
  "client",
  "license",
  "subscription",
]);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A key whose value is itself a credential. The head noun decides, so
 * `accessToken` and `privateKey` count while `maxTokens`, `tokenLimit` and the
 * `apiKeyEnv` indirection (the name of an environment variable) do not.
 */
function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  const head = words.at(-1);
  if (!head || head === "env") return false;
  if (SECRET_HEAD_WORDS.has(head)) return true;
  return head === "key" && (words.length === 1 || SECRET_KEY_QUALIFIERS.has(words[words.length - 2]));
}

function hasNonEmptyCredentialValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "bigint") return true;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.some((item) => hasNonEmptyCredentialValue(item));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => hasNonEmptyCredentialValue(item));
  }
  return false;
}

export function hasInlineSecret(obj: unknown): boolean {
  if (typeof obj === "string") return SECRET_VALUE_RE.test(obj.trim());
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) return obj.some((item) => hasInlineSecret(item));
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialKey(key) && hasNonEmptyCredentialValue(value)) return true;
    if (hasInlineSecret(value)) return true;
  }
  return false;
}

function stripInlineComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") {
        if (line[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line.replace(/\s+$/, "");
}

function countIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

function findUnquotedColon(text: string, allowTightQuotedColon = false): number {
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let justClosedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else {
          quote = null;
          justClosedQuote = depth === 0;
        }
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') {
        quote = null;
        justClosedQuote = depth === 0;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      justClosedQuote = false;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
      justClosedQuote = false;
    } else if ((ch === "]" || ch === "}") && depth > 0) {
      depth--;
      justClosedQuote = false;
    } else if (
      ch === ":" &&
      depth === 0 &&
      (i + 1 === text.length || /\s/.test(text[i + 1]) || (allowTightQuotedColon && justClosedQuote))
    ) {
      return i;
    } else if (!/\s/.test(ch)) {
      justClosedQuote = false;
    }
  }
  return -1;
}

/**
 * A quoted scalar, or `undefined` when the text is not one. Text that opens a
 * quote without being exactly one quoted scalar is rejected rather than read as
 * a plain string that dsh would parse differently.
 */
function quotedScalar(trimmed: string): string | undefined {
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"') return undefined;
  const inner = trimmed.slice(1, -1);
  if (trimmed.length >= 2 && trimmed.endsWith(quote)) {
    if (quote === "'" && !/'/.test(inner.replace(/''/g, ""))) return inner.replace(/''/g, "'");
    if (quote === '"' && !/"/.test(inner.replace(/\\[\s\S]/g, ""))) return unescapeDoubleQuoted(inner);
  }
  throw new Error("Unsupported multi-line or malformed quoted YAML scalar in cordis.patch.yml.");
}

const ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: "\u2028",
  P: "\u2029",
};

function unescapeDoubleQuoted(raw: string): string {
  return raw.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_, seq: string) => {
    if (seq.length === 1) {
      if (Object.prototype.hasOwnProperty.call(ESCAPES, seq)) return ESCAPES[seq];
      throw new Error(`Unsupported YAML escape "\\${seq}" in cordis.patch.yml.`);
    }
    const code = Number.parseInt(seq.slice(1), 16);
    if (code > 0x10ffff) throw new Error("Invalid YAML unicode escape in cordis.patch.yml.");
    return String.fromCodePoint(code);
  });
}

/**
 * Resolve a plain (unquoted) scalar the way dsh's YAML 1.2 core schema does,
 * so a value keeps its type when MemCode rewrites the patch. Plain forms whose
 * type MemCode cannot reproduce exactly are refused instead of guessed.
 */
function resolvePlain(text: string): unknown {
  if (text === "" || /^(?:~|null|Null|NULL)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  const radix = /^([-+]?)0(x[0-9a-fA-F]+|o[0-7]+|b[01]+)$/.exec(text);
  if (radix) {
    const value = Number.parseInt(radix[2].slice(1), { x: 16, o: 8, b: 2 }[radix[2][0] as "x" | "o" | "b"]);
    return radix[1] === "-" ? -value : value;
  }
  if (/^[-+]?[0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/.test(text) || /^\.[0-9]+(?:[eE][-+]?[0-9]+)?$/.test(text)) {
    return Number(text);
  }
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return Number.NaN;
  // Underscore digit separators and timestamps load as numbers or dates in
  // dsh, with edge rules MemCode does not reproduce.
  if (
    (text.includes("_") &&
      (/^[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?$/.test(text) ||
        /^\.[0-9_]+(?:[eE][-+]?[0-9]+)?$/.test(text) ||
        /^[-+]?0[xob][0-9a-fA-F_]+$/.test(text))) ||
    /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:$|[Tt ])/.test(text)
  ) {
    throw new Error(`Unsupported YAML scalar "${text}" in cordis.patch.yml.`);
  }
  return text;
}

function unquoteKey(raw: string): string {
  const trimmed = raw.trim();
  const quoted = quotedScalar(trimmed);
  if (quoted !== undefined) return quoted;
  // dsh resolves a plain key's type first and then uses its string form.
  const resolved = resolvePlain(trimmed);
  return resolved === null ? "null" : String(resolved);
}

function assertSupportedYamlToken(trimmed: string): void {
  if (/^&[^\s,\]}]+/.test(trimmed) || /^\*[^\s,\]}]+/.test(trimmed)) {
    throw new Error("YAML anchors and aliases are not supported in cordis.patch.yml.");
  }
  if (/^![^!]|^!!(?!js(?:\/[A-Za-z0-9_-]+)?(?:\s|$))/i.test(trimmed)) {
    throw new Error("Unsupported YAML tag in cordis.patch.yml.");
  }
}

function parseScalar(raw: string, ctx: { hasJsExpression: boolean }): { value: unknown; taggedJs: boolean } {
  let trimmed = raw.trim();
  let taggedJs = false;
  const jsMatch = /^!!js(?:\/[A-Za-z0-9_-]+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (jsMatch) {
    ctx.hasJsExpression = true;
    taggedJs = true;
    trimmed = (jsMatch[1] ?? "").trim();
    if (!trimmed) return { value: undefined, taggedJs: true };
  }
  assertSupportedYamlToken(trimmed);
  const quoted = quotedScalar(trimmed);
  if (quoted !== undefined) return { value: quoted, taggedJs };
  return { value: resolvePlain(trimmed), taggedJs };
}

function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote === "'") {
      if (ch === "'") {
        if (inner[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if ((ch === "]" || ch === "}") && depth > 0) depth--;
    else if (ch === "," && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const tail = inner.slice(start);
  if (tail.trim()) items.push(tail);
  return items;
}

function parseFlow(text: string, ctx: { hasJsExpression: boolean }): { value: unknown; taggedJs: boolean } {
  let trimmed = text.trim();
  let taggedJs = false;
  const jsMatch = /^!!js(?:\/[A-Za-z0-9_-]+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (jsMatch) {
    ctx.hasJsExpression = true;
    taggedJs = true;
    trimmed = (jsMatch[1] ?? "").trim();
  }
  const mark = <T>(value: T, anyJs: boolean): T =>
    taggedJs ? markExplicitJs(value) : anyJs ? markJsExpr(value) : value;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      const arr: unknown[] = [];
      return { value: mark(arr, false), taggedJs };
    }
    let anyJs = taggedJs;
    const arr = splitFlowItems(inner).map((item) => {
      const res = parseFlow(item, ctx);
      if (res.taggedJs) anyJs = true;
      return res.value;
    });
    return { value: mark(arr, anyJs), taggedJs: anyJs };
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (!inner) return { value: mark(obj, false), taggedJs };
    let anyJs = taggedJs;
    for (const part of splitFlowItems(inner)) {
      const colon = findUnquotedColon(part, true);
      if (colon === -1) {
        throw new Error("Unsupported or malformed YAML flow mapping entry in cordis.patch.yml.");
      }
      const key = unquoteKey(part.slice(0, colon));
      if (key === "<<") {
        throw new Error("YAML merge keys are not supported in cordis.patch.yml.");
      }
      const res = parseFlow(part.slice(colon + 1), ctx);
      if (res.taggedJs) anyJs = true;
      obj[key] = res.value;
    }
    return { value: mark(obj, anyJs), taggedJs: anyJs };
  }
  const scalar = parseScalar(trimmed, ctx);
  return { value: scalar.value, taggedJs: taggedJs || scalar.taggedJs };
}

function isFlowComplete(text: string): boolean {
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if ((ch === "]" || ch === "}") && depth > 0) depth--;
  }
  return quote === null && depth === 0;
}

class YamlParser {
  readonly lines: string[];
  index = 0;
  hasJsExpression = false;

  constructor(text: string) {
    this.lines = text.replace(/\r\n?/g, "\n").split("\n");
  }

  private skipIgnorable(): void {
    while (this.index < this.lines.length) {
      const cleaned = stripInlineComment(this.lines[this.index]);
      if (cleaned.trim() === "") this.index++;
      else break;
    }
  }

  private peekContent(): { indent: number; text: string } | null {
    this.skipIgnorable();
    if (this.index >= this.lines.length) return null;
    const cleaned = stripInlineComment(this.lines[this.index]);
    return { indent: countIndent(cleaned), text: cleaned.trimStart() };
  }

  private parseBlockScalar(header: string, parentIndent: number): string {
    const style = header[0] as "|" | ">";
    const rest = header.slice(1).trim();
    const chomp = rest.includes("-") ? "-" : rest.includes("+") ? "+" : "";
    const indentDigit = /\d+/.exec(rest)?.[0];
    let contentIndent = indentDigit ? parentIndent + Number.parseInt(indentDigit, 10) : -1;
    const rawLines: string[] = [];

    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      const indent = countIndent(line);
      if (line.trim() === "") {
        rawLines.push("");
        this.index++;
        continue;
      }
      if (contentIndent === -1) {
        if (indent <= parentIndent) break;
        contentIndent = indent;
      } else if (indent < contentIndent) {
        break;
      }
      rawLines.push(line.slice(contentIndent));
      this.index++;
    }

    let trailingEmpty = 0;
    while (trailingEmpty < rawLines.length && rawLines[rawLines.length - 1 - trailingEmpty] === "") {
      trailingEmpty++;
    }
    const contentLines = rawLines.slice(0, rawLines.length - trailingEmpty);

    let body: string;
    if (style === "|") {
      body = contentLines.join("\n");
    } else {
      // Folding joins two adjacent normal lines with a space. A line that is
      // more indented keeps its surrounding line breaks, and each empty line
      // between two normal lines stands for one line break.
      let previous: "normal" | "more" | null = null;
      let empty = 0;
      body = "";
      for (const line of contentLines) {
        if (line === "") {
          empty++;
          continue;
        }
        const kind = /^[ \t]/.test(line) ? "more" : "normal";
        if (previous === null) body += "\n".repeat(empty);
        else if (previous === "normal" && kind === "normal") body += empty ? "\n".repeat(empty) : " ";
        else body += "\n".repeat(empty + 1);
        body += line;
        previous = kind;
        empty = 0;
      }
    }

    if (contentLines.length === 0) return chomp === "+" ? "\n".repeat(trailingEmpty) : "";
    if (chomp === "-") return body;
    return body + "\n" + (chomp === "+" ? "\n".repeat(trailingEmpty) : "");
  }

  private collectFlow(firstPart: string): string {
    let acc = firstPart;
    while (!isFlowComplete(acc) && this.index < this.lines.length) {
      const next = stripInlineComment(this.lines[this.index++]).trim();
      if (next) acc += " " + next;
    }
    if (!isFlowComplete(acc)) {
      throw new Error("Incomplete YAML flow collection in cordis.patch.yml.");
    }
    return acc;
  }

  private parseValue(rawVal: string, parentIndent: number): { value: unknown; taggedJs: boolean } {
    const val = rawVal.trim();
    assertSupportedYamlToken(val);
    const jsOnly = /^!!js(?:\/[A-Za-z0-9_-]+)?$/.exec(val);
    if (jsOnly) {
      this.hasJsExpression = true;
      const next = this.peekContent();
      if (next && next.indent > parentIndent) {
        const parsed = this.parseBlock(next.indent);
        return { value: markExplicitJs(parsed.value ?? {}), taggedJs: true };
      }
      return { value: undefined, taggedJs: true };
    }
    const jsPrefixed = /^!!js(?:\/[A-Za-z0-9_-]+)?\s+([\s\S]+)$/.exec(val);
    if (jsPrefixed) {
      this.hasJsExpression = true;
      const inner = jsPrefixed[1].trim();
      if (/^[|>][+-]?\d*$/.test(inner)) {
        return { value: this.parseBlockScalar(inner, parentIndent), taggedJs: true };
      }
      if (inner.startsWith("[") || inner.startsWith("{")) {
        const res = parseFlow(this.collectFlow(inner), this);
        return { value: markExplicitJs(res.value), taggedJs: true };
      }
      return { value: parseScalar(val, this).value, taggedJs: true };
    }
    if (/^[|>][+-]?\d*$/.test(val)) {
      return { value: this.parseBlockScalar(val, parentIndent), taggedJs: false };
    }
    if (val === "") {
      const next = this.peekContent();
      const isSeq = next && (next.text === "-" || next.text.startsWith("- "));
      if (next && (next.indent > parentIndent || (next.indent === parentIndent && isSeq))) {
        return this.parseBlock(next.indent);
      }
      return { value: null, taggedJs: false };
    }
    if (val.startsWith("[") || val.startsWith("{")) {
      return parseFlow(this.collectFlow(val), this);
    }
    return parseScalar(val, this);
  }

  private parseMapping(minIndent: number, seed?: { key: string; rawVal: string; lineIndent: number }): { value: Record<string, unknown>; taggedJs: boolean } {
    const obj: Record<string, unknown> = {};
    let anyJs = false;
    if (seed) {
      if (seed.key === "<<") {
        throw new Error("YAML merge keys are not supported in cordis.patch.yml.");
      }
      const res = this.parseValue(seed.rawVal, seed.lineIndent);
      if (res.taggedJs) anyJs = true;
      obj[seed.key] = res.value;
    }

    while (true) {
      const next = this.peekContent();
      if (!next || next.indent < minIndent || next.indent !== minIndent) break;
      if (next.text === "-" || next.text.startsWith("- ")) break;
      const colon = findUnquotedColon(next.text);
      if (colon === -1) break;
      this.index++;
      const key = unquoteKey(next.text.slice(0, colon));
      if (key === "<<") {
        throw new Error("YAML merge keys are not supported in cordis.patch.yml.");
      }
      const rawVal = next.text.slice(colon + 1);
      const res = this.parseValue(rawVal, next.indent);
      if (res.taggedJs) anyJs = true;
      obj[key] = res.value;
    }
    return { value: anyJs ? markJsExpr(obj) : obj, taggedJs: anyJs };
  }

  private parseSequence(seqIndent: number): { value: unknown[]; taggedJs: boolean } {
    const arr: unknown[] = [];
    let anyJs = false;
    while (true) {
      const next = this.peekContent();
      if (!next || next.indent !== seqIndent) break;
      if (next.text !== "-" && !next.text.startsWith("- ")) break;
      const lineIdx = this.index++;
      const afterDash = next.text.slice(1).trimStart();
      if (!afterDash) {
        const nested = this.peekContent();
        if (nested && nested.indent > seqIndent) {
          const res = this.parseBlock(nested.indent);
          if (res.taggedJs) anyJs = true;
          arr.push(res.value);
        } else {
          arr.push(null);
        }
        continue;
      }

      const dashCol = countIndent(this.lines[lineIdx]);
      const itemIndent = dashCol + (next.text.length - afterDash.length);
      const colon = findUnquotedColon(afterDash);
      if (colon !== -1 && !afterDash.startsWith("{") && !afterDash.startsWith("[")) {
        const key = unquoteKey(afterDash.slice(0, colon));
        const rawVal = afterDash.slice(colon + 1);
        const res = this.parseMapping(itemIndent, { key, rawVal, lineIndent: itemIndent });
        if (res.taggedJs) anyJs = true;
        arr.push(res.value);
      } else if (afterDash === "-" || afterDash.startsWith("- ")) {
        // Nested inline sequence `- - a`
        this.lines[lineIdx] = " ".repeat(itemIndent) + afterDash;
        this.index = lineIdx;
        const res = this.parseSequence(itemIndent);
        if (res.taggedJs) anyJs = true;
        arr.push(res.value);
      } else {
        const res = this.parseValue(afterDash, itemIndent);
        if (res.taggedJs) anyJs = true;
        arr.push(res.value);
      }
    }
    return { value: anyJs ? markJsExpr(arr) : arr, taggedJs: anyJs };
  }

  parseTopLevel(): { value: unknown; taggedJs: boolean } {
    let next = this.peekContent();
    if (!next) return { value: [], taggedJs: false };
    if (next.text === "---") {
      this.index++;
      next = this.peekContent();
      if (!next) return { value: [], taggedJs: false };
    }
    if (next.text === "...") {
      this.index++;
      if (this.peekContent() !== null) {
        throw new Error("Multiple YAML documents are not supported in cordis.patch.yml.");
      }
      return { value: [], taggedJs: false };
    }
    const parsed = this.parseBlock();
    const trailing = this.peekContent();
    if (trailing?.text === "...") {
      this.index++;
      if (this.peekContent() !== null) {
        throw new Error("Incomplete or unsupported YAML in cordis.patch.yml.");
      }
    } else if (trailing !== null) {
      throw new Error("Incomplete or unsupported YAML in cordis.patch.yml.");
    }
    if (!Array.isArray(parsed.value)) {
      throw new Error("Expected a top-level YAML list in cordis.patch.yml.");
    }
    return parsed;
  }

  parseBlock(expectedIndent?: number): { value: unknown; taggedJs: boolean } {
    const next = this.peekContent();
    if (!next) return { value: [], taggedJs: false };
    const indent = expectedIndent ?? next.indent;
    if (next.text === "---") {
      this.index++;
      return this.parseBlock();
    }
    if (next.text === "-" || next.text.startsWith("- ")) {
      return this.parseSequence(indent);
    }
    if (next.text.startsWith("[") || next.text.startsWith("{")) {
      this.index++;
      return parseFlow(this.collectFlow(next.text), this);
    }
    if (findUnquotedColon(next.text) !== -1) {
      return this.parseMapping(indent);
    }
    this.index++;
    return parseScalar(next.text, this);
  }
}

export function parseDshPatchYaml(text: string): { entries: any[]; hasJsExpression: boolean } {
  const parser = new YamlParser(text);
  const parsed = parser.parseTopLevel();
  return { entries: parsed.value as any[], hasJsExpression: parser.hasJsExpression };
}

/** Whether a plain (unquoted) spelling would load back as this exact string. */
function plainKeepsString(text: string): boolean {
  // YAML 1.1 booleans are strings under dsh's core schema; quote them anyway
  // so no older reader turns them into booleans.
  if (/^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|<<|=)$/.test(text)) return false;
  try {
    return resolvePlain(text) === text;
  } catch {
    return false;
  }
}

function needsQuotes(text: string): boolean {
  if (text === "") return true;
  if (/^\s|\s$/.test(text)) return true;
  if (!plainKeepsString(text)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(text)) return true;
  if (/:(?:\s|$)/.test(text) || /\s#/.test(text)) return true;
  return false;
}

function formatKey(key: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(key) && !needsQuotes(key)) return key;
  return formatString(key);
}

const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\0": "\\0",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
};

function formatString(value: string): string {
  // Control and other non-printable characters are only safe escaped.
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029\ufeff]/.test(value)) {
    return `"${value.replace(
      /[\x00-\x1f\x7f-\x9f"\\\u2028\u2029\ufeff]/g,
      (ch) => DOUBLE_QUOTED_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )}"`;
  }
  if (!needsQuotes(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (value === Infinity) return ".inf";
    if (value === -Infinity) return "-.inf";
    if (Object.is(value, -0)) return "-0.0";
    return String(value);
  }
  return formatString(String(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dumpValue(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines: string[] = [];
    for (const item of value) {
      if (isPlainObject(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          lines.push(`${pad}- {}`);
          continue;
        }
        const [firstKey, firstVal] = entries[0];
        if ((isPlainObject(firstVal) && Object.keys(firstVal).length > 0) || (Array.isArray(firstVal) && firstVal.length > 0)) {
          lines.push(`${pad}- ${formatKey(firstKey)}:`);
          lines.push(...dumpValue(firstVal, indent + 4));
        } else {
          lines.push(`${pad}- ${formatKey(firstKey)}: ${formatInlineEmptyOrScalar(firstVal)}`);
        }
        for (const [k, v] of entries.slice(1)) {
          lines.push(...dumpEntry(k, v, indent + 2));
        }
      } else if (Array.isArray(item)) {
        if (item.length === 0) lines.push(`${pad}- []`);
        else {
          lines.push(`${pad}-`);
          lines.push(...dumpValue(item, indent + 2));
        }
      } else {
        lines.push(`${pad}- ${formatScalar(item)}`);
      }
    }
    return lines;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${pad}{}`];
    const lines: string[] = [];
    for (const [k, v] of entries) {
      lines.push(...dumpEntry(k, v, indent));
    }
    return lines;
  }
  return [`${pad}${formatScalar(value)}`];
}

function formatInlineEmptyOrScalar(value: unknown): string {
  if (Array.isArray(value)) return "[]";
  if (isPlainObject(value)) return "{}";
  return formatScalar(value);
}

function dumpEntry(key: string, value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  const k = formatKey(key);
  if ((isPlainObject(value) && Object.keys(value).length > 0) || (Array.isArray(value) && value.length > 0)) {
    return [`${pad}${k}:`, ...dumpValue(value, indent + 2)];
  }
  return [`${pad}${k}: ${formatInlineEmptyOrScalar(value)}`];
}

export function stringifyDshPatchYaml(entries: unknown[]): string {
  if (!Array.isArray(entries) || entries.length === 0) return "[]\n";
  return dumpValue(entries, 0).join("\n") + "\n";
}
