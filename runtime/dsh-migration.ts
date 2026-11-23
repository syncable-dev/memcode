import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  DshDesktopDiff,
  DshDesktopProviderCandidate,
  DshDryRunResult,
  DshProviderFailure,
  DshSkippedDesktopItem,
  ModelOption,
} from "../src/shared";
import { probeStandardCatalog } from "./agents/standard-acp";
import { childEnv, type Command } from "./commands";
import {
  inspectDshProfiles,
  isTemporaryDryRunProfile,
  normalizeDshProfile,
  resolveDshHome,
} from "./dsh-profiles";
import {
  hasExplicitJsTag,
  hasInlineSecret,
  hasJsTag,
  parseDshPatchYaml,
  stringifyDshPatchYaml,
} from "./dsh-yaml";

const execFileAsync = promisify(execFile);
const STALE_DRYRUN_AGE_MS = 60 * 60 * 1000;
const DRYRUN_MARKER = ".memcode-dryrun";
const DRYRUN_MARKER_TEXT = "memcode-dryrun\n";
/** Every file `dsh plugin add` or a patch import can change, restored on rollback. */
const PROFILE_FILES = [
  "package.json",
  "cordis.patch.yml",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
] as const;
type ProfileFile = (typeof PROFILE_FILES)[number];
type ProfileSnapshot = Map<ProfileFile, Buffer | null>;

export type StrictAcpProbe = (profile: string, command: Command) => Promise<ModelOption[]>;

/**
 * What a successful dry-run verified. Apply accepts only this plan and refuses
 * to mutate the profile when Desktop, the home patch, or the target changed.
 */
export interface DshMigrationPlan {
  fingerprint: string;
  targetProfile: string;
  selectedIds: string[];
  /** Catalog entries the dry-run saw appear; apply must show every one. */
  expectedModelIds: string[];
}

interface DesktopPatchData {
  piAiProviders: Map<string, Record<string, unknown>>;
  pluginConfigRows: Map<string, Record<string, unknown>>;
  homePatch: Buffer | null;
  diff: DshDesktopDiff;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildDshEnv(dshHome: string, command: Command, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...childEnv(),
    ...command.env,
    ...(env !== process.env ? env : {}),
    DSH_HOME: dshHome,
  };
}

function withDshHomeCommand(command: Command, dshHome: string, env: NodeJS.ProcessEnv): Command {
  return {
    ...command,
    env: {
      ...command.env,
      ...(env !== process.env && env.PATH ? { PATH: env.PATH } : {}),
      DSH_HOME: dshHome,
    },
  };
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    const detail = err.stderr?.trim() || err.stdout?.trim();
    return detail ? `${err.message}: ${detail}` : err.message;
  }
  return String(error);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonSafe(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readPatchStrict(path: string): Promise<{ entries: any[]; hasJsExpression: boolean }> {
  const text = await readOptional(path);
  return text === null ? { entries: [], hasJsExpression: false } : parseDshPatchYaml(text.toString("utf8"));
}

async function readPatchSafe(path: string): Promise<{ entries: any[]; hasJsExpression: boolean }> {
  try {
    return await readPatchStrict(path);
  } catch {
    return { entries: [], hasJsExpression: false };
  }
}

/** Snapshot every profile file; an unreadable existing file aborts instead of reading as absent. */
async function readProfileSnapshot(profileDir: string): Promise<ProfileSnapshot> {
  const snapshot: ProfileSnapshot = new Map();
  for (const file of PROFILE_FILES) {
    try {
      snapshot.set(file, await readOptional(join(profileDir, file)));
    } catch (error) {
      throw new Error(`Cannot read existing profile file "${file}": ${extractErrorMessage(error)}`);
    }
  }
  return snapshot;
}

function isPiAiRow(entry: unknown): entry is Record<string, unknown> {
  return (
    isPlainObject(entry) &&
    (entry.id === "llm-pi-ai" || entry.name === "@deepseek-ai/dsh-llm-pi-ai")
  );
}

/**
 * The llm-pi-ai providers one patch layer sets. A row that sets `config`
 * replaces the whole configuration of earlier layers and rows, so only the
 * last such row counts. Providers under an explicitly `!!js`-tagged entry,
 * config or providers container are never offered, but an untagged sibling of
 * a tagged provider still is.
 */
function extractPiAiProviders(entries: unknown[]): {
  providers: Map<string, Record<string, unknown>>;
  tainted: boolean;
  configured: boolean;
} {
  let providers = new Map<string, Record<string, unknown>>();
  let tainted = false;
  let configured = false;
  for (const entry of entries) {
    if (!isPiAiRow(entry)) continue;
    if (hasExplicitJsTag(entry)) {
      configured = true;
      providers = new Map();
      tainted = true;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(entry, "config")) continue;
    configured = true;
    providers = new Map();
    tainted = false;
    const config = entry.config;
    if (!isPlainObject(config) || hasExplicitJsTag(config)) {
      tainted = hasJsTag(entry);
      continue;
    }
    const rawProviders = config.providers;
    if (!isPlainObject(rawProviders) || hasExplicitJsTag(rawProviders)) {
      tainted = hasJsTag(config);
      continue;
    }
    for (const [providerId, providerConfig] of Object.entries(rawProviders)) {
      if (isPlainObject(providerConfig)) providers.set(providerId, providerConfig);
    }
  }
  return { providers, tainted, configured };
}

function extractModelIds(providerConfig: Record<string, unknown>): string[] {
  if (!Array.isArray(providerConfig.models)) return [];
  const ids: string[] = [];
  for (const model of providerConfig.models) {
    if (typeof model === "string" && model.trim()) ids.push(model.trim());
    else if (isPlainObject(model)) {
      const id = typeof model.id === "string" ? model.id.trim() : typeof model.name === "string" ? model.name.trim() : "";
      if (id) ids.push(id);
    }
  }
  return ids;
}

function findMatchingPluginRow(
  entries: unknown[],
  pkgName: string,
): Record<string, unknown> | undefined {
  const shortName = pkgName.replace(/^@[^/]+\//, "").replace(/^dsh-/, "");
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    if (Array.isArray(entry.insert) && !entry.id && !entry.name) continue;
    if (entry.name === pkgName || entry.id === shortName || entry.id === pkgName) {
      return entry;
    }
  }
  return undefined;
}

function buildPluginSpec(pkgName: string, rawSpec: unknown, desktopDir: string): {
  spec: string;
  source: "registry" | "local-link";
  defaultSelected: boolean;
  warning?: string;
} {
  const trimmed = typeof rawSpec === "string" ? rawSpec.trim() : "";
  const local = /^(link|file):([\s\S]*)$/.exec(trimmed);
  if (local) {
    // dsh runs plugin commands inside the selected profile directory, so a
    // relative path must be resolved against Desktop's profile, not copied.
    const path = local[2];
    const absolute = isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
    return {
      spec: `${local[1]}:${absolute ? path : resolve(desktopDir, path)}`,
      source: "local-link",
      defaultSelected: false,
      warning: "Local linked plugin may add non-LLM hooks or require Desktop services.",
    };
  }
  const spec = trimmed
    ? /^(?:https?:|git\+|npm:|github:|workspace:)/i.test(trimmed)
      ? trimmed
      : `${pkgName}@${trimmed}`
    : pkgName;
  return {
    spec,
    source: "registry",
    defaultSelected: true,
  };
}

async function computeDesktopDiff(
  targetProfile: string,
  env: NodeJS.ProcessEnv,
): Promise<DesktopPatchData> {
  const normalizedTarget = normalizeDshProfile(targetProfile);
  const dshHome = resolveDshHome(env);
  const desktopDir = join(dshHome, "profiles", "desktop");
  const targetDir = join(dshHome, "profiles", normalizedTarget);
  const homePatchPath = join(dshHome, "cordis.patch.yml");
  let homePatchBytes: Buffer | null = null;
  let homePatchUnreadable = false;
  try {
    homePatchBytes = await readOptional(homePatchPath);
  } catch {
    homePatchUnreadable = true;
  }

  if (!(await isDirectory(desktopDir))) {
    return {
      piAiProviders: new Map(),
      pluginConfigRows: new Map(),
      homePatch: homePatchBytes,
      diff: {
        targetProfile: normalizedTarget,
        desktopPresent: false,
        providers: [],
        skipped: [],
      },
    };
  }

  let desktopPatch: { entries: any[]; hasJsExpression: boolean } = { entries: [], hasJsExpression: false };
  let desktopPatchUnsupported = false;
  try {
    desktopPatch = await readPatchStrict(join(desktopDir, "cordis.patch.yml"));
  } catch {
    desktopPatchUnsupported = true;
  }
  let homePatch: { entries: any[]; hasJsExpression: boolean } = { entries: [], hasJsExpression: false };
  let homePatchUnsupported = homePatchUnreadable;
  try {
    homePatch = homePatchBytes === null ? homePatch : parseDshPatchYaml(homePatchBytes.toString("utf8"));
  } catch {
    homePatchUnsupported = true;
  }
  const [desktopPkg, targetPatch, targetPkg] = await Promise.all([
    readJsonSafe(join(desktopDir, "package.json")),
    readPatchSafe(join(targetDir, "cordis.patch.yml")),
    readJsonSafe(join(targetDir, "package.json")),
  ]);

  const providers: DshDesktopProviderCandidate[] = [];
  const skipped: DshSkippedDesktopItem[] = [];
  if (desktopPatchUnsupported) {
    skipped.push({
      name: "cordis.patch.yml",
      reason: "Desktop cordis.patch.yml uses unsupported YAML syntax and was skipped.",
    });
  }
  const piAiProviders = new Map<string, Record<string, unknown>>();
  const pluginConfigRows = new Map<string, Record<string, unknown>>();

  const desktopPiAi = extractPiAiProviders(desktopPatch.entries);
  // dsh composes the profile patch first and the home patch last; a home row
  // that sets llm-pi-ai's config replaces the profile's provider list.
  const homePiAi = extractPiAiProviders(homePatch.entries);
  const effective = homePiAi.configured ? homePiAi : extractPiAiProviders(targetPatch.entries);
  const existingModels = new Map<string, Set<string>>();
  for (const [providerId, cfg] of effective.providers) {
    existingModels.set(providerId, new Set(extractModelIds(cfg)));
  }
  const maskedReason = homePatchUnsupported
    ? `${homePatchPath} could not be read or uses unsupported YAML, so MemCode cannot tell whether it replaces this profile's providers.`
    : homePiAi.configured
      ? `${homePatchPath} sets llm-pi-ai for every profile and would hide this import. Add the provider there instead.`
      : undefined;

  if (desktopPiAi.tainted) {
    skipped.push({
      name: "llm-pi-ai",
      reason: "Desktop llm-pi-ai configuration contains !!js expression and was skipped.",
    });
  } else {
    for (const [providerId, cfg] of desktopPiAi.providers) {
      if (hasJsTag(cfg)) {
        skipped.push({
          name: providerId,
          reason: "Contains !!js expression; skipped for safety.",
        });
        continue;
      }
      if (hasInlineSecret(cfg)) {
        skipped.push({
          name: providerId,
          reason: "Contains inline credential or secret; use apiKeyEnv or .credentials.yaml.",
        });
        continue;
      }
      const models = extractModelIds(cfg);
      const existing = existingModels.get(providerId);
      const missingModels = existing ? models.filter((m) => !existing.has(m)) : undefined;
      if (existing && (!missingModels || missingModels.length === 0)) continue;
      if (maskedReason) {
        skipped.push({ name: providerId, reason: maskedReason });
        continue;
      }

      piAiProviders.set(providerId, cfg);
      const displayName =
        typeof cfg.displayName === "string" && cfg.displayName.trim()
          ? cfg.displayName.trim()
          : providerId;
      providers.push({
        id: `pi-ai:${providerId}`,
        kind: "pi-ai",
        name: displayName,
        providerId,
        models,
        ...(missingModels ? { missingModels } : {}),
        defaultSelected: true,
      });
    }
  }

  const targetPackages = new Set<string>([
    ...(Array.isArray((targetPkg.dsh as { profile?: { bundles?: unknown[] } } | undefined)?.profile?.bundles)
      ? ((targetPkg.dsh as { profile: { bundles: unknown[] } }).profile.bundles.filter(
          (b): b is string => typeof b === "string",
        ))
      : []),
    ...(isPlainObject(targetPkg.dependencies) ? Object.keys(targetPkg.dependencies) : []),
  ]);

  const desktopBundles = Array.isArray(
    (desktopPkg.dsh as { profile?: { bundles?: unknown[] } } | undefined)?.profile?.bundles,
  )
    ? ((desktopPkg.dsh as { profile: { bundles: unknown[] } }).profile.bundles.filter(
        (b): b is string => typeof b === "string",
      ))
    : [];
  const desktopDeps = isPlainObject(desktopPkg.dependencies) ? desktopPkg.dependencies : {};
  const desktopPackages = [...new Set([...desktopBundles, ...Object.keys(desktopDeps)])];

  for (const pkgName of desktopPackages) {
    if (pkgName.startsWith("@deepseek-ai/") || targetPackages.has(pkgName)) continue;

    const pkgDir = join(desktopDir, "node_modules", ...pkgName.split("/"));
    const pkgJson = await readJsonSafe(join(pkgDir, "package.json"));
    const peers = isPlainObject(pkgJson.peerDependencies) ? pkgJson.peerDependencies : null;
    if (!peers || !Object.prototype.hasOwnProperty.call(peers, "@deepseek-ai/dsh-llm")) {
      continue;
    }

    const exportsField = isPlainObject(pkgJson.exports) ? pkgJson.exports : null;
    const dotExport = exportsField && isPlainObject(exportsField["."]) ? exportsField["."] : null;
    const mainRel =
      typeof pkgJson.main === "string" && pkgJson.main.trim()
        ? pkgJson.main.trim()
        : typeof dotExport?.default === "string"
          ? dotExport.default
          : typeof exportsField?.["."] === "string"
            ? (exportsField["."] as string)
            : "";
    if (!mainRel) continue;

    const mainPath = join(pkgDir, mainRel);
    if (relative(pkgDir, mainPath).startsWith("..")) continue;
    let mainSource = "";
    try {
      mainSource = await readFile(mainPath, "utf8");
    } catch {
      continue;
    }
    if (!mainSource.includes("registerAdapter(")) continue;

    const { spec, source, defaultSelected, warning } = buildPluginSpec(
      pkgName,
      desktopDeps[pkgName],
      desktopDir,
    );
    const configRow = findMatchingPluginRow(desktopPatch.entries, pkgName);
    let hasConfigPatch = false;
    if (configRow) {
      if (hasJsTag(configRow) || hasInlineSecret(configRow)) {
        skipped.push({
          name: pkgName,
          reason: "Desktop config row contains !!js or inline secrets and was skipped.",
        });
      } else {
        pluginConfigRows.set(pkgName, configRow);
        hasConfigPatch = true;
      }
    }

    providers.push({
      id: `plugin:${pkgName}`,
      kind: "plugin",
      name: pkgName,
      providerId: pkgName,
      models: [],
      source,
      spec,
      ...(hasConfigPatch ? { hasConfigPatch: true } : {}),
      defaultSelected,
      ...(warning ? { warning } : {}),
    });
  }

  return {
    piAiProviders,
    pluginConfigRows,
    homePatch: homePatchBytes,
    diff: {
      targetProfile: normalizedTarget,
      desktopPresent: true,
      providers,
      skipped,
    },
  };
}

export async function diffDshDesktopModels(
  targetProfile: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DshDesktopDiff> {
  return (await computeDesktopDiff(targetProfile, env)).diff;
}

/** Every selected id must still be offered; stale or unknown ids are refused, never skipped. */
function staleSelections(selectedIds: string[], data: DesktopPatchData): DshProviderFailure[] {
  const offered = new Set(data.diff.providers.map((p) => p.id));
  return selectedIds
    .filter((id) => !offered.has(id))
    .map((id) => ({
      id,
      name: id.replace(/^(?:pi-ai|plugin):/, ""),
      reason: "No longer offered by DeepSeek Harness Desktop. Reload the provider list and test again.",
    }));
}

function hashBytes(bytes: Buffer | null): string | null {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

/** Binds a plan to the exact Desktop sources, home patch and target files it tested. */
function migrationFingerprint(
  targetProfile: string,
  selectedIds: string[],
  data: DesktopPatchData,
  snapshot: ProfileSnapshot,
): string {
  const byId = new Map(data.diff.providers.map((p) => [p.id, p]));
  const sources = [...selectedIds].sort().map((id) => {
    const candidate = byId.get(id);
    const providerId = candidate?.providerId ?? id;
    return {
      id,
      spec: candidate?.spec ?? null,
      models: candidate?.missingModels ?? candidate?.models ?? null,
      config: data.piAiProviders.get(providerId) ?? data.pluginConfigRows.get(providerId) ?? null,
    };
  });
  return createHash("sha256")
    .update(
      JSON.stringify({
        targetProfile,
        sources,
        home: hashBytes(data.homePatch),
        files: PROFILE_FILES.map((file) => [file, hashBytes(snapshot.get(file) ?? null)]),
      }),
    )
    .digest("hex");
}

function mergePatchEntries(
  existingEntries: any[],
  selectedIds: string[],
  data: DesktopPatchData,
): any[] {
  const entries = cloneJson(existingEntries);
  const selectedPiAi = selectedIds
    .filter((id) => id.startsWith("pi-ai:"))
    .map((id) => id.slice("pi-ai:".length));

  if (selectedPiAi.length > 0) {
    let piAiEntry = [...entries].reverse().find(
      (entry) => isPiAiRow(entry) && Object.prototype.hasOwnProperty.call(entry, "config"),
    ) ?? entries.find((entry) => isPiAiRow(entry));
    if (!piAiEntry) {
      piAiEntry = {
        id: "llm-pi-ai",
        name: "@deepseek-ai/dsh-llm-pi-ai",
        config: { providers: {} },
      };
      entries.push(piAiEntry);
    }
    if (!isPlainObject(piAiEntry.config)) piAiEntry.config = {};
    if (!isPlainObject(piAiEntry.config.providers)) piAiEntry.config.providers = {};

    for (const providerId of selectedPiAi) {
      const desktopCfg = data.piAiProviders.get(providerId);
      if (!desktopCfg) continue;
      const existingCfg = piAiEntry.config.providers[providerId];
      if (!isPlainObject(existingCfg)) {
        piAiEntry.config.providers[providerId] = cloneJson(desktopCfg);
      } else if (Array.isArray(desktopCfg.models)) {
        const currentModels = Array.isArray(existingCfg.models) ? existingCfg.models : [];
        const existingIds = new Set(extractModelIds(existingCfg));
        for (const model of desktopCfg.models) {
          const modelId =
            typeof model === "string"
              ? model
              : isPlainObject(model)
                ? (typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "")
                : "";
          if (modelId && !existingIds.has(modelId)) {
            currentModels.push(cloneJson(model));
            existingIds.add(modelId);
          }
        }
        existingCfg.models = currentModels;
      }
    }
  }

  for (const id of selectedIds) {
    if (!id.startsWith("plugin:")) continue;
    const pkgName = id.slice("plugin:".length);
    const row = data.pluginConfigRows.get(pkgName);
    if (!row) continue;
    const alreadyExists = entries.some(
      (entry) =>
        isPlainObject(entry) &&
        ((row.id !== undefined && entry.id === row.id) ||
          (row.name !== undefined && entry.name === row.name)),
    );
    if (!alreadyExists) {
      entries.push(cloneJson(row));
    }
  }

  return entries;
}

async function runDshPlugin(
  command: Command,
  profileName: string,
  args: string[],
  dshHome: string,
  env: NodeJS.ProcessEnv,
  timeout = 120_000,
): Promise<void> {
  await execFileAsync(
    command.command,
    [...command.prefix, "plugin", "--profile", profileName, ...args],
    {
      shell: false,
      windowsHide: true,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
      env: buildDshEnv(dshHome, command, env),
    },
  );
}

/** Reinstall a profile's dependency tree from its manifest and lockfile, as `dsh plugin` repairs it. */
function installArgs(hasLockfile: boolean): string[] {
  return ["install", hasLockfile ? "--frozen-lockfile" : "--config.lockfile=false"];
}

function hasDependencies(pkg: Buffer | null | undefined): boolean {
  if (!pkg) return false;
  try {
    const parsed = JSON.parse(pkg.toString("utf8"));
    return isPlainObject(parsed?.dependencies) && Object.keys(parsed.dependencies).length > 0;
  } catch {
    return false;
  }
}

async function applySelectedToProfileDir(
  command: Command,
  profileName: string,
  profileDir: string,
  selectedIds: string[],
  data: DesktopPatchData,
  dshHome: string,
  env: NodeJS.ProcessEnv,
  progress?: { pluginStart?: (id: string, pkgName: string) => void; pluginsDone?: () => void },
): Promise<void> {
  const patchPath = join(profileDir, "cordis.patch.yml");
  const currentPatch = await readPatchStrict(patchPath);
  if (currentPatch.hasJsExpression) {
    throw new Error(
      "Target profile cordis.patch.yml contains !!js expressions and cannot be modified safely.",
    );
  }

  const byId = new Map(data.diff.providers.map((p) => [p.id, p]));
  for (const id of selectedIds) {
    if (!id.startsWith("plugin:")) continue;
    const candidate = byId.get(id);
    if (!candidate) {
      throw new Error(`Selected migration candidate "${id}" was not found in Desktop profile.`);
    }
    progress?.pluginStart?.(id, candidate.name);
    await runDshPlugin(command, profileName, ["add", candidate.spec ?? candidate.providerId], dshHome, env);
  }
  progress?.pluginsDone?.();

  const merged = mergePatchEntries(currentPatch.entries, selectedIds, data);
  await writeFile(patchPath, stringifyDshPatchYaml(merged), "utf8");
}

async function cleanupStaleDryRunDirs(profilesDir: string): Promise<void> {
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !isTemporaryDryRunProfile(entry.name)) continue;
      const dir = join(profilesDir, entry.name);
      try {
        // Only a directory MemCode created and marked is ever removed.
        const marker = await readFile(join(dir, DRYRUN_MARKER), "utf8").catch(() => null);
        if (marker !== DRYRUN_MARKER_TEXT) continue;
        const info = await stat(dir);
        if (now - info.mtimeMs > STALE_DRYRUN_AGE_MS) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch {
        /* Ignore transient cleanup failure. */
      }
    }
  } catch {
    /* profilesDir may not exist yet. */
  }
}

async function assertExistingAcpProfile(
  profile: string,
  env: NodeJS.ProcessEnv,
): Promise<{ dshHome: string; normalizedTarget: string; targetDir: string }> {
  const normalizedTarget = normalizeDshProfile(profile);
  const inspected = await inspectDshProfiles(normalizedTarget, env);
  if (inspected.activeProfileIssue === "missing") {
    throw new Error(`DeepSeek Harness profile "${normalizedTarget}" does not exist.`);
  }
  if (inspected.activeProfileIssue === "non-acp") {
    throw new Error(`DeepSeek Harness profile "${normalizedTarget}" is not an ACP profile.`);
  }
  return {
    dshHome: inspected.dshHome,
    normalizedTarget,
    targetDir: join(inspected.dshHome, "profiles", normalizedTarget),
  };
}

/** The provider a dsh catalog entry belongs to: ACP values are JSON `[provider, model]`. */
function catalogEntry(model: ModelOption): { provider?: string; model: string } {
  try {
    const parsed = JSON.parse(model.id);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === "string"))
      return { provider: parsed[0], model: parsed[1] };
  } catch {
    /* Not a dsh provider tuple. */
  }
  return { provider: model.group, model: model.id };
}

function sameProvider(provider: string | undefined, providerId: string): boolean {
  return (
    provider === providerId ||
    !!provider?.endsWith(`:${providerId}`) ||
    !!provider?.endsWith(`/${providerId}`)
  );
}

/**
 * Check that each selected provider really contributes to the catalog: a
 * pi-ai provider must list every model it was imported for, and a plugin must
 * add at least one model from a provider the baseline did not have.
 */
function unmetExpectations(
  ids: string[],
  data: DesktopPatchData,
  baseline: ModelOption[],
  after: ModelOption[],
): DshProviderFailure[] {
  const byId = new Map(data.diff.providers.map((p) => [p.id, p]));
  const entries = after.map((model) => ({ id: model.id, ...catalogEntry(model) }));
  const baselineIds = new Set(baseline.map((model) => model.id));
  const baselineProviders = new Set(baseline.map((model) => catalogEntry(model).provider));
  const piAiProviders = ids
    .filter((id) => id.startsWith("pi-ai:"))
    .map((id) => byId.get(id)?.providerId ?? id.slice("pi-ai:".length));
  const failures: DshProviderFailure[] = [];
  for (const id of ids) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (candidate.kind === "pi-ai") {
      const expected = candidate.missingModels ?? candidate.models;
      const listed = (modelId?: string) =>
        entries.some((entry) => {
          if (modelId !== undefined && entry.model !== modelId) return false;
          // An entry without provider identity can only vouch for a named model.
          if (entry.provider === undefined) return modelId !== undefined;
          return sameProvider(entry.provider, candidate.providerId) || entry.provider === candidate.name;
        });
      const missing = expected.length ? expected.filter((modelId) => !listed(modelId)) : listed() ? [] : ["any model"];
      if (missing.length)
        failures.push({
          id,
          name: candidate.name,
          reason: `DeepSeek Harness did not list ${missing.join(", ")} for this provider after the import. Check its configuration and API key environment variable in Desktop.`,
        });
    }
  }
  const plugins = ids.filter((id) => byId.get(id)?.kind === "plugin");
  if (plugins.length) {
    const added = new Set(
      entries
        .filter(
          (entry) =>
            !baselineIds.has(entry.id) &&
            !baselineProviders.has(entry.provider) &&
            !piAiProviders.some((providerId) => sameProvider(entry.provider, providerId)),
        )
        .map((entry) => entry.provider ?? entry.id),
    );
    if (added.size < plugins.length)
      for (const id of plugins)
        failures.push({
          id,
          name: byId.get(id)?.name ?? id,
          reason:
            plugins.length === 1
              ? "The plugin installed, but DeepSeek Harness listed no new models from it. Configure its provider in Desktop first."
              : `The selected plugins added models from ${added.size} new provider${added.size === 1 ? "" : "s"}, not ${plugins.length}.`,
        });
  }
  return failures;
}

function defaultProbe(options?: { probe?: StrictAcpProbe }): StrictAcpProbe {
  return (
    options?.probe ??
    ((profile, cmd) =>
      probeStandardCatalog("dsh", cmd, profile, { strictStdout: true, allowStaging: true }))
  );
}

export async function dryRunDshMigration(
  command: Command,
  targetProfile: string,
  selectedIds: string[],
  options?: { env?: NodeJS.ProcessEnv; probe?: StrictAcpProbe },
): Promise<DshDryRunResult & { plan?: DshMigrationPlan }> {
  const env = options?.env ?? process.env;
  const { dshHome, normalizedTarget, targetDir } = await assertExistingAcpProfile(targetProfile, env);
  const profilesDir = join(dshHome, "profiles");
  await cleanupStaleDryRunDirs(profilesDir);

  const probeCmd = withDshHomeCommand(command, dshHome, env);
  const probe = defaultProbe(options);
  const ids = [...new Set(selectedIds)];

  if (ids.length === 0) {
    const previewModels = await probe(normalizedTarget, probeCmd);
    return {
      ok: true,
      targetProfile: normalizedTarget,
      passedIds: [],
      failed: [],
      previewModels,
    };
  }

  const profileFailure = (reason: string): DshDryRunResult => ({
    ok: false,
    targetProfile: normalizedTarget,
    passedIds: [],
    failed: [{ id: `profile:${normalizedTarget}`, name: normalizedTarget, reason }],
    previewModels: [],
    error: reason,
  });

  // The fingerprint and every staging copy come from the same bytes.
  let snapshot: ProfileSnapshot;
  try {
    snapshot = await readProfileSnapshot(targetDir);
  } catch (error) {
    return profileFailure(extractErrorMessage(error));
  }
  const data = await computeDesktopDiff(normalizedTarget, env);
  const stale = staleSelections(ids, data);
  if (stale.length) {
    return {
      ok: false,
      targetProfile: normalizedTarget,
      passedIds: [],
      failed: stale,
      previewModels: [],
      error: "Some selected providers are no longer offered by DeepSeek Harness Desktop.",
    };
  }
  const candidateMap = new Map(data.diff.providers.map((p) => [p.id, p]));
  const targetHasDependencies = hasDependencies(snapshot.get("package.json"));

  const runStaging = async (stagedIds: string[]): Promise<ModelOption[]> => {
    const stagingName = `memcode-dryrun-${randomBytes(4).toString("hex")}`;
    const stagingDir = join(profilesDir, stagingName);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, DRYRUN_MARKER), DRYRUN_MARKER_TEXT, "utf8");
    try {
      for (const [file, content] of snapshot) {
        if (content !== null) await writeFile(join(stagingDir, file), content);
      }
      // A profile's third-party bundles load from its own node_modules. Build
      // an independent tree in staging; `plugin add` installs it as well.
      if (targetHasDependencies && !stagedIds.some((id) => id.startsWith("plugin:"))) {
        await runDshPlugin(
          command,
          stagingName,
          installArgs(snapshot.get("pnpm-lock.yaml") != null),
          dshHome,
          env,
        );
      }
      if (stagedIds.length > 0) {
        await applySelectedToProfileDir(command, stagingName, stagingDir, stagedIds, data, dshHome, env);
      }
      return await probe(stagingName, probeCmd);
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  // An already broken profile is a profile failure, never blamed on providers.
  let baseline: ModelOption[];
  try {
    baseline = await runStaging([]);
  } catch (baselineError) {
    return profileFailure(
      `Existing ACP profile failed validation before applying Desktop providers: ${extractErrorMessage(baselineError)}`,
    );
  }

  const attempt = async (stagedIds: string[]): Promise<{ models: ModelOption[]; failures: DshProviderFailure[] }> => {
    const models = await runStaging(stagedIds);
    return { models, failures: unmetExpectations(stagedIds, data, baseline, models) };
  };

  let combinedError: string;
  try {
    const combined = await attempt(ids);
    if (combined.failures.length === 0) {
      const baselineIds = new Set(baseline.map((model) => model.id));
      return {
        ok: true,
        targetProfile: normalizedTarget,
        passedIds: ids,
        failed: [],
        previewModels: combined.models,
        plan: {
          fingerprint: migrationFingerprint(normalizedTarget, ids, data, snapshot),
          targetProfile: normalizedTarget,
          selectedIds: ids,
          expectedModelIds: combined.models
            .map((model) => model.id)
            .filter((id) => !baselineIds.has(id)),
        },
      };
    }
    combinedError = combined.failures.map((failure) => `${failure.name}: ${failure.reason}`).join(" ");
  } catch (error) {
    combinedError = extractErrorMessage(error);
  }

  const passedIds: string[] = [];
  const failed: DshProviderFailure[] = [];
  for (const id of ids) {
    const candidate = candidateMap.get(id);
    try {
      const single = await attempt([id]);
      if (single.failures.length) failed.push(...single.failures);
      else passedIds.push(id);
    } catch (error) {
      failed.push({
        id,
        name: candidate?.name ?? id,
        reason: extractErrorMessage(error),
      });
    }
  }
  const combinationError =
    failed.length === 0
      ? `Selected providers passed individually but failed when combined: ${combinedError}`
      : undefined;
  return {
    ok: false,
    targetProfile: normalizedTarget,
    passedIds,
    failed,
    previewModels: [],
    ...(combinationError ? { error: combinationError } : {}),
  };
}

export interface DshApplyResult {
  ok: boolean;
  appliedIds: string[];
  failed: DshProviderFailure[];
  models: ModelOption[];
  error?: string;
  /** False when rollback could not restore the profile; it may need manual recovery. */
  restored?: boolean;
}

export async function applyDshMigration(
  command: Command,
  plan: DshMigrationPlan,
  options?: { env?: NodeJS.ProcessEnv; probe?: StrictAcpProbe },
): Promise<DshApplyResult> {
  const env = options?.env ?? process.env;
  const { dshHome, normalizedTarget, targetDir } = await assertExistingAcpProfile(plan.targetProfile, env);
  const probeCmd = withDshHomeCommand(command, dshHome, env);
  const probe = defaultProbe(options);
  const selectedIds = plan.selectedIds;
  const profileId = `profile:${normalizedTarget}`;
  const refuse = (reason: string): DshApplyResult => ({
    ok: false,
    appliedIds: [],
    failed: [{ id: profileId, name: normalizedTarget, reason }],
    models: [],
    error: reason,
    restored: true,
  });

  if (normalizedTarget !== plan.targetProfile || selectedIds.length === 0)
    return refuse("Test the selected providers before importing them.");

  let snapshots: ProfileSnapshot;
  try {
    snapshots = await readProfileSnapshot(targetDir);
  } catch (error) {
    return refuse(`${extractErrorMessage(error)}. The profile was not modified.`);
  }
  const data = await computeDesktopDiff(normalizedTarget, env);
  if (
    staleSelections(selectedIds, data).length > 0 ||
    migrationFingerprint(normalizedTarget, selectedIds, data, snapshots) !== plan.fingerprint
  )
    return refuse(
      "DeepSeek Harness Desktop or this profile changed after the dry-run. Test the selected providers again before importing them.",
    );
  const candidateMap = new Map(data.diff.providers.map((p) => [p.id, p]));

  const selectedPlugins = selectedIds
    .filter((id) => id.startsWith("plugin:"))
    .map((id) => id.slice("plugin:".length));
  const preExistingPlugins = new Set<string>();
  for (const pkgName of selectedPlugins) {
    if (await isDirectory(join(targetDir, "node_modules", ...pkgName.split("/")))) {
      preExistingPlugins.add(pkgName);
    }
  }

  // A failure is the profile's until a specific plugin is being installed.
  let activeId = profileId;
  let activeName = normalizedTarget;
  let dependenciesTouched = false;
  try {
    await applySelectedToProfileDir(
      command,
      normalizedTarget,
      targetDir,
      selectedIds,
      data,
      dshHome,
      env,
      {
        pluginStart: (id, name) => {
          activeId = id;
          activeName = candidateMap.get(id)?.name ?? name;
          dependenciesTouched = true;
        },
        pluginsDone: () => {
          activeId = profileId;
          activeName = normalizedTarget;
        },
      },
    );
    const models = await probe(normalizedTarget, probeCmd);
    const listed = new Set(models.map((model) => model.id));
    const missing = plan.expectedModelIds.filter((id) => !listed.has(id));
    if (missing.length > 0)
      throw new Error(
        `After the import DeepSeek Harness did not list ${missing.length} model${missing.length === 1 ? "" : "s"} the dry-run verified: ${missing.join(", ")}.`,
      );
    return {
      ok: true,
      appliedIds: [...selectedIds],
      failed: [],
      models,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const [file, content] of snapshots) {
      const path = join(targetDir, file);
      try {
        if (content === null) {
          await rm(path, { force: true });
        } else {
          await writeFile(path, content);
        }
      } catch (rbError) {
        rollbackErrors.push(`${file}: ${extractErrorMessage(rbError)}`);
      }
    }
    if (dependenciesTouched) {
      for (const pkgName of selectedPlugins) {
        if (!preExistingPlugins.has(pkgName)) {
          try {
            await rm(join(targetDir, "node_modules", ...pkgName.split("/")), {
              recursive: true,
              force: true,
            });
          } catch (rbError) {
            rollbackErrors.push(`node_modules/${pkgName}: ${extractErrorMessage(rbError)}`);
          }
        }
      }
      // `plugin add` can also change existing and transitive dependencies.
      // Reinstall the restored lockfile, as dsh itself does after a rejected add.
      if (rollbackErrors.length === 0) {
        try {
          await runDshPlugin(
            command,
            normalizedTarget,
            installArgs(snapshots.get("pnpm-lock.yaml") != null),
            dshHome,
            env,
            300_000,
          );
        } catch (rbError) {
          rollbackErrors.push(
            `node_modules could not be reinstalled (${extractErrorMessage(rbError)}); run "dsh plugin --profile ${normalizedTarget} install"`,
          );
        }
      }
    }
    const reason = extractErrorMessage(error);
    if (rollbackErrors.length > 0) {
      const recoveryDir = join(
        dshHome,
        "memcode-recovery",
        `${normalizedTarget}-${Date.now()}-${randomBytes(3).toString("hex")}`,
      );
      let recoveryNote = "";
      try {
        await mkdir(recoveryDir, { recursive: true });
        for (const [file, content] of snapshots) {
          if (content !== null) {
            await writeFile(join(recoveryDir, file), content);
          }
        }
        recoveryNote = ` Recovery snapshots saved to ${recoveryDir}.`;
      } catch (backupError) {
        recoveryNote = ` Could not write recovery snapshots (${extractErrorMessage(backupError)}).`;
      }
      const fullError = `Migration failed (${reason}) and rollback could not restore all files (${rollbackErrors.join("; ")}).${recoveryNote}`;
      return {
        ok: false,
        appliedIds: [],
        failed: [{ id: activeId, name: activeName, reason: fullError }],
        models: [],
        error: fullError,
        restored: false,
      };
    }
    return {
      ok: false,
      appliedIds: [],
      failed: [
        {
          id: activeId,
          name: activeName,
          reason,
        },
      ],
      models: [],
      error: reason,
      restored: true,
    };
  }
}
