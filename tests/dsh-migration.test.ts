import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyDshMigration,
  diffDshDesktopModels,
  dryRunDshMigration,
  type DshMigrationPlan,
} from "../runtime/dsh-migration";
import {
  hasExplicitJsTag,
  hasInlineSecret,
  hasJsTag,
  parseDshPatchYaml,
  stringifyDshPatchYaml,
} from "../runtime/dsh-yaml";
import { exists } from "../runtime/commands";

async function setupMigrationFixture(t: test.TestContext): Promise<{
  dshHome: string;
  env: NodeJS.ProcessEnv;
  desktopDir: string;
  targetDir: string;
}> {
  const dshHome = await mkdtemp(join(tmpdir(), "memcode-dsh-migrate-"));
  t.after(() => rm(dshHome, { recursive: true, force: true }));

  const desktopDir = join(dshHome, "profiles", "desktop");
  const targetDir = join(dshHome, "profiles", "custom-acp");
  await mkdir(join(desktopDir, "node_modules"), { recursive: true });
  await mkdir(targetDir, { recursive: true });

  await writeFile(
    targetDir + "/package.json",
    JSON.stringify(
      {
        name: "dsh-profile-custom-acp",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] } },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(targetDir, "cordis.patch.yml"),
    stringifyDshPatchYaml([
      { id: "ui-theme", config: { fontSize: 14 } },
      {
        id: "llm-pi-ai",
        name: "@deepseek-ai/dsh-llm-pi-ai",
        config: {
          providers: {
            partial: {
              displayName: "Partial",
              apiKeyEnv: "PARTIAL_KEY",
              models: [{ id: "m1", name: "m1" }],
            },
          },
        },
      },
    ]),
  );
  await writeFile(join(targetDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  return { dshHome, env: { DSH_HOME: dshHome }, desktopDir, targetDir };
}

async function writePluginPkg(
  desktopDir: string,
  pkgName: string,
  opts: { hasLlmPeer?: boolean; hasRegisterAdapter?: boolean; main?: string },
): Promise<void> {
  const pkgDir = join(desktopDir, "node_modules", ...pkgName.split("/"));
  await mkdir(join(pkgDir, "lib"), { recursive: true });
  const main = opts.main ?? "lib/index.js";
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkgName,
      version: "1.0.0",
      main,
      peerDependencies: opts.hasLlmPeer ? { "@deepseek-ai/dsh-llm": ">=0.2.0" } : {},
    }),
  );
  await writeFile(
    join(pkgDir, main),
    opts.hasRegisterAdapter
      ? "export function apply(ctx) { ctx.llm.registerAdapter(['x'], {}); }\n"
      : "export function apply() {}\n",
  );
}

/**
 * A dsh stand-in that behaves like the real CLI where migration depends on it:
 * `plugin` forwards install/add to the profile, a profile's third-party bundles
 * only load from its own node_modules, and catalog values are the JSON
 * `[provider, model]` tuples dsh's ACP model control advertises.
 */
async function writeMockDsh(dshHome: string): Promise<{ command: string; prefix: string[] }> {
  const script = join(dshHome, "mock-dsh.mjs");
  await writeFile(
    script,
    `import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const home = process.env.DSH_HOME;
const profile = argv[argv.indexOf("--profile") + 1];
const pDir = join(home, "profiles", profile);
const readPkg = () => JSON.parse(readFileSync(join(pDir, "package.json"), "utf8"));
if (argv[0] === "plugin") {
  const sub = argv[3];
  appendFileSync(join(home, "calls.log"), profile + " " + argv.slice(3).join(" ") + "\\n");
  if (sub === "install") {
    for (const dep of Object.keys(readPkg().dependencies || {})) mkdirSync(join(pDir, "node_modules", dep), { recursive: true });
    process.exit(0);
  }
  const spec = argv[argv.length - 1];
  const pkgName = spec.split("@")[0];
  if (process.env.MOCK_FAIL_ADD === pkgName) { process.stderr.write("add rejected"); process.exit(1); }
  const pkg = readPkg();
  pkg.dependencies = { ...(pkg.dependencies || {}), [pkgName]: "1.0.0" };
  writeFileSync(join(pDir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(pDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\\nupdated: true\\n");
  writeFileSync(join(pDir, "pnpm-workspace.yaml"), "changed: true\\n");
  for (const dep of Object.keys(pkg.dependencies)) mkdirSync(join(pDir, "node_modules", dep), { recursive: true });
  process.exit(0);
}
const deps = Object.keys(readPkg().dependencies || {});
for (const dep of deps) if (!existsSync(join(pDir, "node_modules", dep))) {
  process.stderr.write("Cannot find bundle " + dep);
  process.exit(3);
}
if (deps.includes("dsh-bad-noise")) process.stdout.write("NOISY_STDOUT_BEFORE_ACP\\n");
const tuples = [["deepseek-official", "deepseek-v4-flash"]];
let provider = null;
const patch = join(pDir, "cordis.patch.yml");
for (const line of existsSync(patch) ? readFileSync(patch, "utf8").split(/\\r?\\n/) : []) {
  const key = /^ {6}([A-Za-z0-9_-]+):\\s*$/.exec(line);
  if (key) { provider = key[1]; continue; }
  const model = /^ {10}- id: (\\S+)/.exec(line);
  if (model && provider && !provider.startsWith("ghost")) tuples.push([provider, model[1]]);
  if (/^ {0,4}\\S/.test(line)) provider = null;
}
for (const dep of deps) if (dep !== "dsh-silent") tuples.push([dep + "-provider", "model"]);
const send = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: {} } });
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/new") {
    const groups = [...new Set(tuples.map(([p]) => p))].map((group) => ({
      group,
      options: tuples.filter(([p]) => p === group).map((tuple) => ({ value: JSON.stringify(tuple), name: tuple[1] })),
    }));
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "s1",
        configOptions: [{ id: "model", category: "model", currentValue: JSON.stringify(tuples[0]), options: groups }],
      },
    });
  }
});
`,
  );
  return { command: process.execPath, prefix: [script] };
}

const tuple = (provider: string, model: string) => JSON.stringify([provider, model]);

async function callsLog(dshHome: string): Promise<string[]> {
  const text = await readFile(join(dshHome, "calls.log"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

test("dsh-yaml parses subset YAML, preserves !!js comment safety, detects real !!js and inline secrets", () => {
  const yaml = `# header comment mentioning \`!!js\` safely
- id: ui-theme
  config:
    tags: [web, news]
    meta: { enabled: true, count: 2 }
    note: |
      line one
      line two
    summary: >
      folded
      text
- id: llm-pi-ai
  config:
    providers:
      clean:
        apiKeyEnv: CLEAN_API_KEY
        models:
          - id: m1
            name: 'model: one'
`;
  const parsed = parseDshPatchYaml(yaml);
  assert.equal(parsed.hasJsExpression, false);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0].config.tags, ["web", "news"]);
  assert.deepEqual(parsed.entries[0].config.meta, { enabled: true, count: 2 });
  assert.equal(parsed.entries[0].config.note, "line one\nline two\n");
  assert.equal(parsed.entries[0].config.summary, "folded text\n");
  assert.equal(hasInlineSecret(parsed.entries), false);

  const roundTripped = parseDshPatchYaml(stringifyDshPatchYaml(parsed.entries));
  assert.deepEqual(roundTripped.entries, parsed.entries);

  const withJs = parseDshPatchYaml("- id: bad\n  fn: !!js/function () => 1\n");
  assert.equal(withJs.hasJsExpression, true);

  assert.equal(hasInlineSecret({ apiKeyEnv: "MY_KEY" }), false);
  assert.equal(hasInlineSecret({ apiKey: "" }), false);
  assert.equal(hasInlineSecret({ apiKey: "sk-live-123" }), true);
  assert.equal(hasInlineSecret({ nested: [{ client_secret: "abc" }] }), true);
  assert.equal(hasInlineSecret({ accessToken: "tok" }), true);
  assert.equal(hasInlineSecret({ password: "pw" }), true);
  assert.equal(hasInlineSecret({ headers: { Authorization: "Bearer tok" } }), true);
  assert.equal(hasInlineSecret({ cookie: "session=abc" }), true);
  assert.equal(hasInlineSecret({ credentials: { user: "u", value: "v" } }), true);
  assert.equal(hasInlineSecret({ custom: "Basic dXNlcjpwYXNz" }), true);

  // Flow-embedded !!js and JSON-style flow mappings
  const jsonFlow = parseDshPatchYaml('[{"id":"ui-theme","config":{"fontSize":14}}]\n');
  assert.deepEqual(jsonFlow.entries, [{ id: "ui-theme", config: { fontSize: 14 } }]);

  const flowJsScalar = parseDshPatchYaml("- id: x\n  items: [!!js/function '() => 1']\n");
  assert.equal(flowJsScalar.hasJsExpression, true);
  assert.equal(hasJsTag(flowJsScalar.entries[0].items), true);

  // Unsupported or incomplete YAML fails closed instead of truncating
  assert.throws(() => parseDshPatchYaml("- id: &a foo\n  ref: *a\n"));
  assert.throws(() => parseDshPatchYaml("id: not-a-list\n"));
  assert.throws(() => parseDshPatchYaml("- id: ok\n  note: first\n    wrapped-continuation\n"));
  assert.throws(() => parseDshPatchYaml("- id: unclosed\n  items: [1, 2\n"));
});

test("dsh-yaml keeps credentials out, including numeric, boolean and private-key fields", () => {
  assert.equal(hasInlineSecret({ privateKey: "-----BEGIN KEY-----" }), true);
  assert.equal(hasInlineSecret({ password: 123456 }), true);
  assert.equal(hasInlineSecret({ "x-api-key": "abc" }), true);
  assert.equal(hasInlineSecret({ key: "abc" }), true);
  assert.equal(hasInlineSecret({ auth: "user:pass" }), true);
  assert.equal(hasInlineSecret({ token: true }), true);
  // Model limits and env-var indirections are not credentials.
  assert.equal(hasInlineSecret({ maxTokens: 4096, tokenLimit: 8000, contextWindow: 128000 }), false);
  assert.equal(hasInlineSecret({ apiKeyEnv: "KEY", tokenEnv: "TOKEN" }), false);
  assert.equal(hasInlineSecret({ auth: false, password: null }), false);
});

test("dsh-yaml round-trips escapes, folded breaks and scalar types without changing them", () => {
  const escaped = parseDshPatchYaml('- a: "x\\by\\fz\\u00e9\\U0001F600\\e\\/"\n');
  assert.equal(escaped.entries[0].a, "x\by\fz\u00e9\u{1F600}\x1b/");
  assert.throws(() => parseDshPatchYaml('- a: "bad \\q escape"\n'), /escape/);
  assert.throws(() => parseDshPatchYaml("- a: \"unterminated\n"));
  assert.throws(() => parseDshPatchYaml("- a: 'it's'\n"));

  const folded = parseDshPatchYaml("- note: >\n    intro\n      code\n    outro\n");
  assert.equal(folded.entries[0].note, "intro\n  code\noutro\n");
  const spec = parseDshPatchYaml(
    "- s: >\n\n    folded\n    line\n\n    next\n    line\n      * bullet\n\n      * list\n      * lines\n\n    last\n    line\n",
  );
  assert.equal(spec.entries[0].s, "\nfolded line\nnext line\n  * bullet\n\n  * list\n  * lines\n\nlast line\n");

  const typed = parseDshPatchYaml(
    "- a: True\n  b: NULL\n  c: 0x10\n  d: 0o17\n  e: .inf\n  f: -.Inf\n  g: 1e3\n  h: '+.5'\n  i: \"True\"\n  j: '0x10'\n  k: 'NULL'\n  l: +.5\n",
  );
  const row = typed.entries[0];
  assert.equal(row.a, true);
  assert.equal(row.b, null);
  assert.equal(row.c, 16);
  assert.equal(row.d, 15);
  assert.equal(row.e, Infinity);
  assert.equal(row.f, -Infinity);
  assert.equal(row.g, 1000);
  assert.equal(row.i, "True");
  assert.equal(row.j, "0x10");
  assert.equal(row.k, "NULL");
  assert.equal(row.l, "+.5");

  const keys = parseDshPatchYaml("- 'True': quoted\n  True: plain\n  '123': q\n  0x1F: hex\n");
  assert.deepEqual(keys.entries[0], { True: "quoted", true: "plain", "123": "q", "31": "hex" });

  const values = [
    {
      strings: ["True", "NULL", "0x10", "1.50", ".inf", "yes", "2024", "", " padded ", "a: b", "#tag"],
      control: "tab\there\bbell\x07del\x7f",
      numbers: [Infinity, -Infinity, 0.5, 1e21],
      nan: Number.NaN,
      "True": 1,
      "123": 2,
      "1.50": 3,
    },
  ];
  const text = stringifyDshPatchYaml(values);
  assert.deepEqual(parseDshPatchYaml(text).entries, values);

  // Forms whose type cannot be reproduced exactly are refused, not guessed.
  assert.throws(() => parseDshPatchYaml("- released: 2024-01-15\n"), /Unsupported YAML scalar/);
  assert.throws(() => parseDshPatchYaml("- size: 1_000\n"), /Unsupported YAML scalar/);
});

test("dsh-yaml distinguishes an explicit !!js tag from one inherited from a descendant", () => {
  const parsed = parseDshPatchYaml(
    "- id: x\n  config: !!js\n    a: 1\n  other:\n    b: !!js/function () => 1\n  flow: !!js [1, 2]\n",
  );
  const row = parsed.entries[0];
  assert.equal(hasExplicitJsTag(row.config), true);
  assert.equal(hasExplicitJsTag(row.other), false);
  assert.equal(hasJsTag(row.other), true);
  assert.equal(hasExplicitJsTag(row.flow), true);
  assert.equal(hasExplicitJsTag(row), false);
});

test("diffDshDesktopModels filters pi-ai providers, plugins, secrets, !!js, and link specs", async (t) => {
  const { dshHome, env, desktopDir } = await setupMigrationFixture(t);

  await writePluginPkg(desktopDir, "dsh-sample-provider", { hasLlmPeer: true, hasRegisterAdapter: true });
  await writePluginPkg(desktopDir, "dsh-local-plugin", { hasLlmPeer: true, hasRegisterAdapter: true });
  await writePluginPkg(desktopDir, "dsh-relative-plugin", { hasLlmPeer: true, hasRegisterAdapter: true });
  await writePluginPkg(desktopDir, "dsh-doublecheck", { hasLlmPeer: false, hasRegisterAdapter: false });
  await writePluginPkg(desktopDir, "dsh-peer-no-adapter", { hasLlmPeer: true, hasRegisterAdapter: false });
  await writePluginPkg(desktopDir, "@deepseek-ai/dsh-internal", { hasLlmPeer: true, hasRegisterAdapter: true });

  await writeFile(
    join(desktopDir, "package.json"),
    JSON.stringify({
      dsh: {
        profile: {
          bundles: [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-internal",
            "dsh-sample-provider",
            "dsh-local-plugin",
            "dsh-relative-plugin",
            "dsh-doublecheck",
            "dsh-peer-no-adapter",
          ],
        },
      },
      dependencies: {
        "dsh-sample-provider": "0.4.6",
        "dsh-local-plugin": "link:D:/fake/dsh-local-plugin",
        "dsh-relative-plugin": "file:./plugins/dsh-relative-plugin",
        "dsh-doublecheck": "0.9.0",
        "dsh-peer-no-adapter": "1.0.0",
      },
    }),
  );

  await writeFile(
    join(desktopDir, "cordis.patch.yml"),
    `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      custom-provider:
        displayName: Custom Provider
        apiKeyEnv: CUSTOM_PROVIDER_API_KEY
        models:
          - id: glm-5
            name: glm-5
      partial:
        displayName: Partial
        apiKeyEnv: PARTIAL_KEY
        models:
          - id: m1
            name: m1
          - id: m2
            name: m2
      home-only:
        apiKeyEnv: HOME_KEY
        models:
          - id: h1
            name: h1
      inline-secret:
        apiKey: sk-secret-value
        models:
          - id: bad
            name: bad
      js-provider:
        transform: !!js/function () { return 1; }
        models:
          - id: js1
            name: js1
- id: sample-provider
  name: dsh-sample-provider
  config:
    freeEnabled: true
`,
  );

  const diff = await diffDshDesktopModels("custom-acp", env);
  assert.equal(diff.desktopPresent, true);
  assert.equal(diff.targetProfile, "custom-acp");

  assert.deepEqual(
    diff.providers.map((p) => [p.id, p.kind, p.source, p.defaultSelected, p.hasConfigPatch]),
    [
      ["pi-ai:custom-provider", "pi-ai", undefined, true, undefined],
      ["pi-ai:partial", "pi-ai", undefined, true, undefined],
      ["pi-ai:home-only", "pi-ai", undefined, true, undefined],
      ["plugin:dsh-sample-provider", "plugin", "registry", true, true],
      ["plugin:dsh-local-plugin", "plugin", "local-link", false, undefined],
      ["plugin:dsh-relative-plugin", "plugin", "local-link", false, undefined],
    ],
  );
  const partial = diff.providers.find((p) => p.id === "pi-ai:partial")!;
  assert.deepEqual(partial.missingModels, ["m2"]);
  const localLink = diff.providers.find((p) => p.id === "plugin:dsh-local-plugin")!;
  assert.match(localLink.warning ?? "", /Local linked plugin/);
  assert.equal(localLink.spec, "link:D:/fake/dsh-local-plugin");
  // dsh runs plugin commands inside the target profile, so a relative spec is
  // resolved against Desktop's profile rather than copied verbatim.
  const relativeLink = diff.providers.find((p) => p.id === "plugin:dsh-relative-plugin")!;
  assert.equal(relativeLink.spec, `file:${resolve(desktopDir, "./plugins/dsh-relative-plugin")}`);

  assert.deepEqual(
    diff.skipped.map((s) => s.name),
    ["inline-secret", "js-provider"],
  );

  // A home llm-pi-ai row replaces every profile's providers, so imports into
  // the profile would be hidden: they are refused, and its models count.
  await writeFile(
    join(dshHome, "cordis.patch.yml"),
    stringifyDshPatchYaml([
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "home-only": { apiKeyEnv: "HOME_KEY", models: [{ id: "h1", name: "h1" }] },
          },
        },
      },
    ]),
  );
  const masked = await diffDshDesktopModels("custom-acp", env);
  assert.deepEqual(
    masked.providers.filter((p) => p.kind === "pi-ai").map((p) => p.id),
    [],
  );
  assert.deepEqual(
    masked.skipped.map((s) => s.name),
    ["custom-provider", "partial", "inline-secret", "js-provider"],
  );
  assert.match(masked.skipped[0].reason, /sets llm-pi-ai for every profile/);
});

test("diffDshDesktopModels refuses providers under an explicitly tagged container but keeps safe siblings", async (t) => {
  const { env, desktopDir } = await setupMigrationFixture(t);
  await writeFile(
    join(desktopDir, "cordis.patch.yml"),
    "- id: llm-pi-ai\n  config:\n    providers: !!js\n      tagged-child:\n        apiKeyEnv: K\n        models:\n          - id: t1\n",
  );
  const tagged = await diffDshDesktopModels("custom-acp", env);
  assert.deepEqual(tagged.providers, []);
  assert.deepEqual(tagged.skipped.map((s) => s.name), ["llm-pi-ai"]);

  await writeFile(
    join(desktopDir, "cordis.patch.yml"),
    "- id: llm-pi-ai\n  config:\n    providers:\n      safe:\n        apiKeyEnv: K\n        models:\n          - id: s1\n      hooked:\n        headers: !!js\n          x: 1\n        models:\n          - id: h1\n",
  );
  const siblings = await diffDshDesktopModels("custom-acp", env);
  assert.deepEqual(siblings.providers.map((p) => p.id), ["pi-ai:safe"]);
  assert.deepEqual(siblings.skipped.map((s) => s.name), ["hooked"]);
});

async function writeCustomProviderDesktop(desktopDir: string, plugins: string[]): Promise<void> {
  for (const plugin of plugins)
    await writePluginPkg(desktopDir, plugin, { hasLlmPeer: true, hasRegisterAdapter: true });
  await writeFile(
    join(desktopDir, "package.json"),
    JSON.stringify({
      dsh: { profile: { bundles: plugins } },
      dependencies: Object.fromEntries(plugins.map((plugin) => [plugin, "1.0.0"])),
    }),
  );
  await writeFile(
    join(desktopDir, "cordis.patch.yml"),
    stringifyDshPatchYaml([
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "custom-provider": { displayName: "Custom Provider", apiKeyEnv: "CUSTOM_PROVIDER_API_KEY", models: [{ id: "r1", name: "r1" }] },
            "ghost-provider": { displayName: "Ghost", apiKeyEnv: "GHOST_KEY", models: [{ id: "g1", name: "g1" }] },
          },
        },
      },
      ...(plugins.includes("dsh-good") ? [{ id: "good", name: "dsh-good", config: { enabled: true } }] : []),
    ]),
  );
}

test("dryRunDshMigration never mutates target profile, cleans staging dirs, and isolates broken providers", async (t) => {
  const { dshHome, env, desktopDir, targetDir } = await setupMigrationFixture(t);
  await writeCustomProviderDesktop(desktopDir, ["dsh-good", "dsh-bad-noise", "dsh-silent"]);

  // Stale marked dryrun directory > 1h old should be cleaned; an unmarked or
  // differently marked directory with the same name shape must stay untouched.
  const staleDir = join(dshHome, "profiles", "memcode-dryrun-deadbeef");
  await mkdir(staleDir, { recursive: true });
  await writeFile(join(staleDir, ".memcode-dryrun"), "memcode-dryrun\n");
  const userDir = join(dshHome, "profiles", "memcode-dryrun-feedface");
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, "package.json"), "{}");
  const forgedDir = join(dshHome, "profiles", "memcode-dryrun-0badf00d");
  await mkdir(forgedDir, { recursive: true });
  await writeFile(join(forgedDir, ".memcode-dryrun"), "mine, not MemCode's\n");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const dir of [staleDir, userDir, forgedDir]) await utimes(dir, twoHoursAgo, twoHoursAgo);

  const cmd = await writeMockDsh(dshHome);
  const beforePkg = await readFile(join(targetDir, "package.json"));
  const beforePatch = await readFile(join(targetDir, "cordis.patch.yml"));
  const beforeLock = await readFile(join(targetDir, "pnpm-lock.yaml"));

  const result = await dryRunDshMigration(
    cmd,
    "custom-acp",
    ["pi-ai:custom-provider", "pi-ai:ghost-provider", "plugin:dsh-good", "plugin:dsh-bad-noise", "plugin:dsh-silent"],
    { env },
  );

  assert.equal(result.ok, false);
  assert.equal(result.plan, undefined);
  assert.deepEqual(result.passedIds, ["pi-ai:custom-provider", "plugin:dsh-good"]);
  assert.deepEqual(
    result.failed.map((f) => f.id),
    ["pi-ai:ghost-provider", "plugin:dsh-bad-noise", "plugin:dsh-silent"],
  );
  // A provider that loads but lists none of its models is not verified.
  assert.match(result.failed[0].reason, /did not list g1/);
  assert.match(result.failed[1].reason, /unreadable|JSON|NOISY_STDOUT/i);
  assert.match(result.failed[2].reason, /no new models/);

  assert.equal(await exists(staleDir), false);
  assert.equal(await exists(userDir), true);
  assert.equal(await exists(forgedDir), true);
  const leftover = (await readdir(join(dshHome, "profiles"))).filter(
    (n) => n.startsWith("memcode-dryrun-") && n !== "memcode-dryrun-feedface" && n !== "memcode-dryrun-0badf00d",
  );
  assert.deepEqual(leftover, []);

  assert.deepEqual(await readFile(join(targetDir, "package.json")), beforePkg);
  assert.deepEqual(await readFile(join(targetDir, "cordis.patch.yml")), beforePatch);
  assert.deepEqual(await readFile(join(targetDir, "pnpm-lock.yaml")), beforeLock);

  const okRun = await dryRunDshMigration(cmd, "custom-acp", ["pi-ai:custom-provider", "plugin:dsh-good"], {
    env,
  });
  assert.equal(okRun.ok, true);
  assert.deepEqual(okRun.passedIds, ["pi-ai:custom-provider", "plugin:dsh-good"]);
  assert.equal(okRun.failed.length, 0);
  assert.ok(okRun.previewModels.some((m) => m.id === tuple("custom-provider", "r1") && m.group === "custom-provider"));
  assert.deepEqual(okRun.plan?.expectedModelIds.sort(), [
    tuple("custom-provider", "r1"),
    tuple("dsh-good-provider", "model"),
  ].sort());

  // A selection Desktop no longer offers is refused, never silently skipped.
  const stale = await dryRunDshMigration(cmd, "custom-acp", ["pi-ai:custom-provider", "pi-ai:removed"], { env });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.failed.map((f) => f.id), ["pi-ai:removed"]);
  assert.match(stale.failed[0].reason, /No longer offered/);
});

test("dryRunDshMigration stages the target's own dependency tree before probing", async (t) => {
  const { dshHome, env, desktopDir, targetDir } = await setupMigrationFixture(t);
  await writeCustomProviderDesktop(desktopDir, []);
  // A healthy customized profile whose third-party bundle loads from node_modules.
  const pkg = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
  pkg.dependencies = { "dsh-existing": "1.0.0" };
  await writeFile(join(targetDir, "package.json"), JSON.stringify(pkg));
  await mkdir(join(targetDir, "node_modules", "dsh-existing"), { recursive: true });

  const cmd = await writeMockDsh(dshHome);
  const result = await dryRunDshMigration(cmd, "custom-acp", ["pi-ai:custom-provider"], { env });
  assert.equal(result.ok, true, result.error ?? "");
  const installs = (await callsLog(dshHome)).filter((line) => / install --frozen-lockfile$/.test(line));
  assert.ok(installs.length >= 2, "baseline and candidate staging both install the target tree");
  assert.ok(installs.every((line) => line.startsWith("memcode-dryrun-")), "the target itself is never reinstalled");
});

test("applyDshMigration applies only the verified plan and fully rolls back on failure", async (t) => {
  const { dshHome, env, desktopDir, targetDir } = await setupMigrationFixture(t);
  await writeCustomProviderDesktop(desktopDir, ["dsh-good"]);
  await writeFile(join(targetDir, "pnpm-workspace.yaml"), "original: true\n");
  const cmd = await writeMockDsh(dshHome);
  const ids = ["pi-ai:custom-provider", "plugin:dsh-good"];
  const snapshot = async () => ({
    pkg: await readFile(join(targetDir, "package.json")),
    patch: await readFile(join(targetDir, "cordis.patch.yml")),
    lock: await readFile(join(targetDir, "pnpm-lock.yaml")),
    workspace: await readFile(join(targetDir, "pnpm-workspace.yaml")),
  });
  const before = await snapshot();
  const planFor = async (): Promise<DshMigrationPlan> => {
    const dryRun = await dryRunDshMigration(cmd, "custom-acp", ids, { env });
    assert.equal(dryRun.ok, true, dryRun.error ?? "");
    return dryRun.plan!;
  };

  // Desktop changed after the dry-run: refuse before touching the profile.
  const stalePlan = await planFor();
  const desktopPatch = join(desktopDir, "cordis.patch.yml");
  const desktopText = await readFile(desktopPatch, "utf8");
  await writeFile(desktopPatch, desktopText.replace("displayName: Custom Provider", "displayName: Changed"));
  const refused = await applyDshMigration(cmd, stalePlan, { env });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /changed after the dry-run/);
  assert.deepEqual(await snapshot(), before);
  await writeFile(desktopPatch, desktopText);

  // A failed post-apply probe belongs to the profile, not the last plugin, and
  // rollback restores every file and reinstalls the restored lockfile.
  const plan = await planFor();
  await rm(join(dshHome, "calls.log"), { force: true });
  const failedApply = await applyDshMigration(cmd, plan, {
    env,
    probe: async () => {
      throw new Error("Simulated post-apply probe failure");
    },
  });
  assert.equal(failedApply.ok, false);
  assert.equal(failedApply.restored, true);
  assert.equal(failedApply.failed[0]?.id, "profile:custom-acp");
  assert.match(failedApply.failed[0]?.reason ?? "", /Simulated post-apply probe failure/);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await exists(join(targetDir, "node_modules", "dsh-good")), false);
  assert.deepEqual(await callsLog(dshHome), [
    "custom-acp add dsh-good@1.0.0",
    "custom-acp install --frozen-lockfile",
  ]);

  // The catalog must still show what the dry-run verified.
  const missing = await applyDshMigration(cmd, plan, {
    env,
    probe: async () => [{ id: tuple("deepseek-official", "deepseek-v4-flash"), label: "v4", source: "acp" }],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /did not list 2 models the dry-run verified/);
  assert.deepEqual(await snapshot(), before);

  // A rejected plugin install is attributed to that plugin.
  const rejected = await applyDshMigration(cmd, plan, {
    env: { ...env, MOCK_FAIL_ADD: "dsh-good" },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failed[0]?.id, "plugin:dsh-good");
  assert.deepEqual(await snapshot(), before);

  const okApply = await applyDshMigration(cmd, plan, { env });
  assert.equal(okApply.ok, true, okApply.error ?? "");
  assert.deepEqual(okApply.appliedIds, ids);
  assert.ok(okApply.models.some((m) => m.id === tuple("custom-provider", "r1")));

  const mergedPatch = parseDshPatchYaml(await readFile(join(targetDir, "cordis.patch.yml"), "utf8"));
  assert.equal(mergedPatch.entries.find((e) => e.id === "ui-theme")?.config?.fontSize, 14);
  assert.ok(mergedPatch.entries.find((e) => e.id === "llm-pi-ai")?.config?.providers?.partial);
  assert.ok(mergedPatch.entries.find((e) => e.id === "llm-pi-ai")?.config?.providers?.["custom-provider"]);
  assert.equal(mergedPatch.entries.find((e) => e.id === "good")?.config?.enabled, true);
  assert.equal(await exists(join(targetDir, "node_modules", "dsh-good")), true);

  // The profile changed since that plan was verified, so it cannot run again.
  const replay = await applyDshMigration(cmd, plan, { env });
  assert.equal(replay.ok, false);
  assert.match(replay.error ?? "", /changed after the dry-run/);
});

test("dryRunDshMigration fails fast on broken baseline, surfaces combination conflicts, and blocks !!js targets", async (t) => {
  const { dshHome, env, desktopDir, targetDir } = await setupMigrationFixture(t);

  await writeFile(
    join(desktopDir, "cordis.patch.yml"),
    stringifyDshPatchYaml([
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            p1: { displayName: "P1", apiKeyEnv: "K1", models: [{ id: "m1", name: "m1" }] },
            p2: { displayName: "P2", apiKeyEnv: "K2", models: [{ id: "m2", name: "m2" }] },
          },
        },
      },
    ]),
  );

  const calls: string[] = [];
  const noopCmd = { command: process.execPath, prefix: ["-e", "process.exit(0)"] };

  // 1. A broken baseline stops before any provider is tested or blamed
  const brokenBase = await dryRunDshMigration(
    noopCmd,
    "custom-acp",
    ["pi-ai:p1", "pi-ai:p2"],
    {
      env,
      probe: async (profile) => {
        calls.push(profile);
        throw new Error("baseline crashed");
      },
    },
  );
  assert.equal(brokenBase.ok, false);
  assert.equal(brokenBase.failed.length, 1);
  assert.equal(brokenBase.failed[0].id, "profile:custom-acp");
  assert.equal(calls.length, 1);

  // 2. Combination conflict: each provider passes alone, combined fails -> ok:false with error
  let comboCall = 0;
  const both = [
    { id: tuple("p1", "m1"), label: "m1", group: "p1", source: "acp" as const },
    { id: tuple("p2", "m2"), label: "m2", group: "p2", source: "acp" as const },
  ];
  const combo = await dryRunDshMigration(
    noopCmd,
    "custom-acp",
    ["pi-ai:p1", "pi-ai:p2"],
    {
      env,
      probe: async () => {
        comboCall++;
        if (comboCall === 1) return [];
        if (comboCall === 2) throw new Error("p1+p2 incompatible");
        return both;
      },
    },
  );
  assert.equal(combo.ok, false);
  assert.deepEqual(combo.failed, []);
  assert.match(combo.error ?? "", /p1\+p2 incompatible/);

  // 3. A target cordis.patch.yml containing !!js is never rewritten
  const taggedTarget = "- id: hook\n  fn: !!js/function '() => 1'\n";
  await writeFile(join(targetDir, "cordis.patch.yml"), taggedTarget);
  const blocked = await dryRunDshMigration(noopCmd, "custom-acp", ["pi-ai:p1"], {
    env,
    probe: async () => both,
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.failed[0]?.reason ?? "", /!!js expressions/);
  assert.equal(await readFile(join(targetDir, "cordis.patch.yml"), "utf8"), taggedTarget);
  void dshHome;
});
