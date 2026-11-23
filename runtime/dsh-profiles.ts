import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DshProfileSummary } from "../src/shared";
import { childEnv, exists, type Command } from "./commands";
import { parseDshPatchYaml } from "./dsh-yaml";

const execFileAsync = promisify(execFile);

export const defaultDshProfile = "acp";

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONFLICTING_APP_BUNDLES = new Set([
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-sdk-app",
  "@deepseek-ai/dsh-tui-app",
  "@deepseek-ai/dsh-headless-app",
]);

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}

export function normalizeDshProfile(
  value?: string,
  options?: { allowStaging?: boolean },
): string {
  const trimmed = value?.trim();
  if (!trimmed) return defaultDshProfile;
  if (trimmed.toLowerCase() === "desktop") {
    throw new Error('Profile name "desktop" is reserved for DeepSeek Harness Desktop and cannot be used as an ACP profile.');
  }
  if (trimmed.toLowerCase() === "node_modules") {
    throw new Error('Profile name "node_modules" is reserved and cannot be used as an ACP profile.');
  }
  if (!options?.allowStaging && isTemporaryDryRunProfile(trimmed)) {
    throw new Error(`Profile name "${trimmed}" is reserved for MemCode temporary dry-run staging.`);
  }
  if (!PROFILE_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid DeepSeek Harness profile name "${trimmed}". Use 1-64 characters matching [A-Za-z0-9._-], starting with a letter or digit.`,
    );
  }
  return trimmed;
}

export function isTemporaryDryRunProfile(name: string): boolean {
  return /^memcode-dryrun-[a-f0-9]+$/i.test(name);
}

/** A directory name MemCode can pass to `dsh --profile` as a user profile. */
function isSelectableProfileName(name: string): boolean {
  try {
    return normalizeDshProfile(name) === name;
  } catch {
    return false;
  }
}

function patchInsertsAcp(entries: unknown[]): boolean {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const insert = (entry as Record<string, unknown>).insert;
    if (!Array.isArray(insert)) continue;
    for (const item of insert) {
      if (item === "@deepseek-ai/dsh-acp") return true;
      if (item && typeof item === "object" && (item as Record<string, unknown>).name === "@deepseek-ai/dsh-acp") {
        return true;
      }
    }
  }
  return false;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function classifyProfileDir(profileDir: string, name: string): Promise<DshProfileSummary> {
  let pkg: { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: unknown[] } } } = {};
  try {
    pkg = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  } catch {
    /* Missing or unreadable package.json; treat as empty. */
  }

  let patchEntries: unknown[] = [];
  try {
    patchEntries = parseDshPatchYaml(await readFile(join(profileDir, "cordis.patch.yml"), "utf8")).entries;
  } catch {
    /* Missing or unreadable cordis.patch.yml; treat as empty. */
  }

  const bundles = Array.isArray(pkg.dsh?.profile?.bundles)
    ? pkg.dsh.profile.bundles.filter((b): b is string => typeof b === "string")
    : [];
  const hasAcp = bundles.includes("@deepseek-ai/dsh-acp-app") || patchInsertsAcp(patchEntries);
  const hasConflict = bundles.some((bundle) => CONFLICTING_APP_BUNDLES.has(bundle));
  const hasCustomConfig =
    Object.keys(pkg.dependencies ?? {}).length > 0 || patchEntries.length > 0;

  return {
    name,
    kind: hasAcp && !hasConflict ? "acp" : "non-acp",
    hasCustomConfig,
  };
}

export interface DshProfilesInspection {
  dshHome: string;
  activeProfile: string;
  configuredProfile?: string;
  recommendedProfile?: string;
  activeProfileIssue?: "missing" | "non-acp";
  acpProfiles: DshProfileSummary[];
  nonAcpProfiles: DshProfileSummary[];
  desktopProfilePresent: boolean;
  needsProfileCreation: boolean;
}

export async function inspectDshProfiles(
  configuredProfile?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DshProfilesInspection> {
  const dshHome = resolveDshHome(env);
  const profilesDir = join(dshHome, "profiles");
  const desktopProfilePresent = await isDirectory(join(profilesDir, "desktop"));

  const acpProfiles: DshProfileSummary[] = [];
  const nonAcpProfiles: DshProfileSummary[] = [];

  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      // Desktop, node_modules, staging and names dsh cannot be given (such as
      // "acp copy" or "_backup") are never offered or selected automatically.
      if (!isSelectableProfileName(name)) continue;
      const fullPath = join(profilesDir, name);
      if (!entry.isDirectory() && !(await isDirectory(fullPath))) continue;
      const summary = await classifyProfileDir(fullPath, name);
      if (summary.kind === "acp") acpProfiles.push(summary);
      else nonAcpProfiles.push(summary);
    }
  } catch {
    /* $DSH_HOME/profiles may not exist yet. */
  }

  acpProfiles.sort((a, b) => a.name.localeCompare(b.name));
  nonAcpProfiles.sort((a, b) => a.name.localeCompare(b.name));

  const acpDefault = acpProfiles.find((p) => p.name === defaultDshProfile);
  const customAcp = acpProfiles.find((p) => p.hasCustomConfig);
  const recommendedProfile =
    customAcp && (!acpDefault || !acpDefault.hasCustomConfig)
      ? customAcp.name
      : acpDefault?.name ?? acpProfiles[0]?.name;

  const trimmedConfigured = configuredProfile?.trim();
  if (trimmedConfigured) {
    const normalized = normalizeDshProfile(trimmedConfigured);
    const inAcp = acpProfiles.find((p) => p.name === normalized);
    const inNonAcp = nonAcpProfiles.find((p) => p.name === normalized);
    return {
      dshHome,
      activeProfile: normalized,
      configuredProfile: normalized,
      ...(recommendedProfile ? { recommendedProfile } : {}),
      ...(!inAcp
        ? { activeProfileIssue: inNonAcp ? ("non-acp" as const) : ("missing" as const) }
        : {}),
      acpProfiles,
      nonAcpProfiles,
      desktopProfilePresent,
      needsProfileCreation: acpProfiles.length === 0,
    };
  }

  if (customAcp && (!acpDefault || !acpDefault.hasCustomConfig)) {
    return {
      dshHome,
      activeProfile: customAcp.name,
      recommendedProfile: customAcp.name,
      acpProfiles,
      nonAcpProfiles,
      desktopProfilePresent,
      needsProfileCreation: false,
    };
  }

  if (acpProfiles.length > 0) {
    const active = acpDefault?.name ?? acpProfiles[0].name;
    return {
      dshHome,
      activeProfile: active,
      ...(recommendedProfile ? { recommendedProfile } : {}),
      acpProfiles,
      nonAcpProfiles,
      desktopProfilePresent,
      needsProfileCreation: false,
    };
  }

  // An existing "acp" directory that is not ACP must not be launched as one.
  const defaultIsNonAcp = nonAcpProfiles.some((p) => p.name === defaultDshProfile);
  return {
    dshHome,
    activeProfile: defaultDshProfile,
    ...(defaultIsNonAcp ? { activeProfileIssue: "non-acp" as const } : {}),
    acpProfiles,
    nonAcpProfiles,
    desktopProfilePresent,
    needsProfileCreation: true,
  };
}

export async function createDshAcpProfile(
  command: Command,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const normalized = normalizeDshProfile(name);
  const targetName = normalized.toLowerCase() === defaultDshProfile ? defaultDshProfile : normalized;
  const dshHome = resolveDshHome(env);
  const profileDir = join(dshHome, "profiles", targetName);

  if (await exists(profileDir)) {
    throw new Error(`DeepSeek Harness profile "${targetName}" already exists.`);
  }

  // dsh rejects --from-default-profile for shipped profile names like "acp".
  const args =
    targetName === defaultDshProfile
      ? [...command.prefix, "--profile", defaultDshProfile, "--dump-config"]
      : [...command.prefix, "--profile", targetName, "--from-default-profile", defaultDshProfile, "--dump-config"];

  await execFileAsync(command.command, args, {
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
    env: {
      ...childEnv(),
      ...command.env,
      ...(env !== process.env ? env : {}),
      DSH_HOME: dshHome,
    },
  });

  const inspected = await inspectDshProfiles(targetName, env);
  if (!inspected.acpProfiles.some((p) => p.name === targetName)) {
    throw new Error(`Created profile "${targetName}" did not produce a valid DeepSeek Harness ACP profile.`);
  }
  return targetName;
}
