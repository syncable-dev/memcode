import { probeCodexCatalog } from "./agents/codex";
import { probeClaudeCatalog } from "./agents/claude";
import { codexCatalogGeneration } from "./agents/codex-models";
import { probeCursorCatalog } from "./agents/cursor";
import {
  commandIdentity,
  findCommand,
  findDesktopApp,
} from "./commands";
import {
  harnessNames,
  type Harness,
  type HarnessRuntime,
  type ModelOption,
} from "../src/shared";

const cached = new Map<Harness, { expires: number; generation: number; value: Promise<HarnessRuntime> }>();

let cursorCache: { identity: string; expires: number; models: Promise<ModelOption[]> } | undefined;
function cursorModels(command: NonNullable<Awaited<ReturnType<typeof findCommand>>>, refresh: boolean) {
  const identity = commandIdentity(command);
  if (cursorCache?.identity === identity && (!refresh || cursorCache.expires === Infinity) && Date.now() < cursorCache.expires)
    return cursorCache.models;
  const entry = { identity, expires: Infinity, models: probeCursorCatalog(command).catch(() => [] as ModelOption[]) };
  cursorCache = entry;
  void entry.models.then((models) => { entry.expires = Date.now() + (models.length ? 15 * 60000 : 60000); });
  return entry.models;
}

async function discoverOne(id: Harness, refresh: boolean): Promise<HarnessRuntime> {
  const [command, desktopAppPath] = await Promise.all([findCommand(id), findDesktopApp(id)]);
  let models: ModelOption[] = [];
  let allModelsDenied = false;
  if (command && id === "codex") {
    const catalog = await probeCodexCatalog(command);
    models = catalog.models;
    allModelsDenied = catalog.allModelsDenied === true;
  }
  if (command && id === "cursor") models = await cursorModels(command, refresh);
  if (command && id === "claude") models = await probeClaudeCatalog(command);
  return {
    id,
    name: harnessNames[id],
    available: !!command,
    path: command?.command ?? null,
    ...(command ? { runtimeIdentity: commandIdentity(command) } : {}),
    ...(desktopAppPath ? { desktopAppPath } : {}),
    models,
    ...(allModelsDenied ? { allModelsDenied } : {}),
    note: command
      ? models.length
        ? "Models offered by the installed harness. The provider confirms access when a turn starts."
        : allModelsDenied ? "Codex rejected every listed model for this account." : "This worker will use its account default when its model list is unavailable."
      : id === "cursor"
        ? "Install the standalone Cursor Agent CLI; the editor alone is not a worker runtime."
        : "No supported local CLI runtime was found.",
  };
}
export async function discoverHarnesses(refresh = false, only?: Harness): Promise<HarnessRuntime[]> {
  const ids: Harness[] = only ? [only] : ["codex", "claude", "cursor"];
  return Promise.all(ids.map((id) => {
    const existing = cached.get(id);
    const generation = id === "codex" ? codexCatalogGeneration : 0;
    if (existing && existing.generation === generation && (!refresh || existing.expires === Infinity) && Date.now() < existing.expires)
      return existing.value;
    const entry = { expires: Infinity, generation, value: discoverOne(id, refresh) };
    cached.set(id, entry);
    void entry.value.then(() => { entry.expires = Date.now() + 60000; }, () => { cached.delete(id); });
    return entry.value;
  }));
}
