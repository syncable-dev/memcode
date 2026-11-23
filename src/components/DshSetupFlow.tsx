import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, RefreshCw, Sparkles } from "lucide-react";
import type {
  DshDesktopDiff,
  DshDryRunResult,
  DshSetupStatus,
  RuntimeInfo,
} from "../shared";
import { desktopPlatform } from "../platform";
import { Spinner } from "./UI";

function defaultCreateName(status: DshSetupStatus): string {
  const taken = new Set([
    ...status.acpProfiles.map((profile) => profile.name.toLowerCase()),
    ...status.nonAcpProfiles.map((profile) => profile.name.toLowerCase()),
  ]);
  return taken.has("acp") ? "memcode-acp" : "acp";
}

function cliInstallExplanation(): string {
  const platform = desktopPlatform();
  if (platform === "windows")
    return "Adds DeepSeek Harness Desktop’s bundled CLI folder to your user PATH so MemCode can run dsh workers.";
  if (platform === "macos")
    return "Links DeepSeek Harness Desktop’s bundled command to /usr/local/bin/dsh.";
  return "Installs DeepSeek Harness Desktop’s bundled dsh command so MemCode can run workers.";
}

export function DshSetupFlow({
  alreadyConnected,
  notify,
  onRuntime,
  onRefreshStatus,
  onReadyChange,
  onClose,
}: {
  alreadyConnected: boolean;
  notify: (text: string) => void;
  onRuntime?: (runtime: RuntimeInfo) => void;
  onRefreshStatus: () => Promise<void>;
  onReadyChange: (ready: boolean) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<DshSetupStatus | null>(null);
  const [diff, setDiff] = useState<DshDesktopDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string>("");
  const [error, setError] = useState("");
  const [needsDesktopMenu, setNeedsDesktopMenu] = useState(false);
  const [installNote, setInstallNote] = useState("");
  const [profileName, setProfileName] = useState("acp");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [dryRunResult, setDryRunResult] = useState<DshDryRunResult | null>(null);
  // Which step produced dryRunResult, and whether a failed import was rolled back.
  const [failure, setFailure] = useState<{ phase: "dry-run" | "import"; restored: boolean }>({
    phase: "dry-run",
    restored: true,
  });
  const [diffError, setDiffError] = useState("");
  const [migrationResult, setMigrationResult] = useState<{
    appliedCount: number;
    modelCount: number;
    targetProfile: string;
  } | null>(null);
  const [skippedSync, setSkippedSync] = useState(false);

  const loadDiff = useCallback(async (nextStatus: DshSetupStatus) => {
    const profileReady =
      nextStatus.cliInstalled &&
      !nextStatus.needsProfileCreation &&
      !nextStatus.activeProfileIssue;
    setDiffError("");
    if (!profileReady || !nextStatus.desktopProfilePresent) {
      setDiff(null);
      setSelectedIds([]);
      return;
    }
    setDiffLoading(true);
    try {
      const nextDiff = await window.memcode.dshDesktopDiff(nextStatus.activeProfile);
      setDiff(nextDiff);
      setSelectedIds(
        nextDiff.providers
          .filter((provider) => provider.defaultSelected)
          .map((provider) => provider.id),
      );
    } catch (err) {
      // A failed comparison says nothing about whether providers are in sync.
      setDiffError((err as Error).message || "The comparison could not be completed.");
      setDiff(null);
      setSelectedIds([]);
    } finally {
      setDiffLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextStatus = await window.memcode.dshSetupStatus();
      setStatus(nextStatus);
      setProfileName(defaultCreateName(nextStatus));
      setDryRunResult(null);
      setMigrationResult(null);
      setSkippedSync(false);
      await loadDiff(nextStatus);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadDiff]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const profileValid =
    !!status &&
    status.cliInstalled &&
    !status.needsProfileCreation &&
    !status.activeProfileIssue;
  const hasPendingProviders =
    (!!diff && diff.providers.length > 0) ||
    (!!diffError && status?.desktopProfilePresent === true);
  const ready =
    !loading &&
    !diffLoading &&
    !busyAction &&
    profileValid &&
    (!hasPendingProviders || !!migrationResult || skippedSync);

  useEffect(() => {
    onReadyChange(ready);
  }, [onReadyChange, ready]);

  const installCli = async () => {
    setBusyAction("install-cli");
    setError("");
    setNeedsDesktopMenu(false);
    setInstallNote("");
    try {
      const result = await window.memcode.installDshCli();
      setStatus(result.status);
      setProfileName(defaultCreateName(result.status));
      onRuntime?.(result.runtime);
      await onRefreshStatus();
      if (result.installed) {
        notify(result.message || "dsh CLI installed.");
        await loadDiff(result.status);
      } else {
        setNeedsDesktopMenu(!!result.needsDesktopMenu);
        setInstallNote(result.message);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const selectProfile = async (name: string) => {
    if (!status || name === status.activeProfile && !status.activeProfileIssue)
      return;
    setBusyAction(`select:${name}`);
    setError("");
    setDryRunResult(null);
    setMigrationResult(null);
    setSkippedSync(false);
    try {
      const result = await window.memcode.selectDshProfile(name);
      setStatus(result.status);
      onRuntime?.(result.runtime);
      await onRefreshStatus();
      await loadDiff(result.status);
      notify(`DeepSeek Harness profile switched to "${result.profile}".`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const createProfile = async () => {
    const trimmed = profileName.trim();
    if (!trimmed) return;
    setBusyAction("create-profile");
    setError("");
    setDryRunResult(null);
    setMigrationResult(null);
    setSkippedSync(false);
    try {
      const result = await window.memcode.createDshProfile(trimmed);
      setStatus(result.status);
      setProfileName(defaultCreateName(result.status));
      onRuntime?.(result.runtime);
      await onRefreshStatus();
      await loadDiff(result.status);
      notify(`Created ACP profile "${result.profile}".`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const runMigration = async (ids: string[]) => {
    if (!status || ids.length === 0) return;
    setBusyAction("migrate");
    setError("");
    setDryRunResult(null);
    setFailure({ phase: "dry-run", restored: true });
    try {
      const dryRun = await window.memcode.dryRunDshMigration({
        targetProfile: status.activeProfile,
        selectedIds: ids,
      });
      // Import only what the combined dry-run verified, through its plan.
      if (!dryRun.ok || dryRun.failed.length > 0 || !dryRun.planId) {
        const failedIds = new Set(dryRun.failed.map((item) => item.id));
        setDryRunResult(dryRun);
        if (failedIds.size > 0) {
          setSelectedIds((current) => current.filter((id) => !failedIds.has(id)));
        }
        return;
      }
      setBusyAction("import");
      const applied = await window.memcode.applyDshMigration({ planId: dryRun.planId });
      onRuntime?.(applied.runtime);
      await onRefreshStatus();
      if (!applied.ok || applied.failed.length > 0) {
        const failedIds = new Set(applied.failed.map((item) => item.id));
        setFailure({ phase: "import", restored: applied.restored !== false });
        setDryRunResult({
          ok: false,
          targetProfile: applied.targetProfile,
          passedIds: applied.appliedIds,
          failed: applied.failed,
          previewModels: applied.models,
          ...(applied.error ? { error: applied.error } : {}),
        });
        if (failedIds.size > 0) {
          setSelectedIds((current) => current.filter((id) => !failedIds.has(id)));
        }
        return;
      }
      const summary = {
        appliedCount: applied.appliedIds.length,
        modelCount: applied.models.length,
        targetProfile: applied.targetProfile,
      };
      setMigrationResult(summary);
      notify(
        `Imported ${summary.appliedCount} provider${summary.appliedCount === 1 ? "" : "s"} into "${summary.targetProfile}" (${summary.modelCount} models verified).`,
      );
      if (alreadyConnected) onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  if (loading && !status) {
    return (
      <div className="dsh-setup-flow dsh-setup-loading">
        <Spinner />
        <span>Checking DeepSeek Harness setup…</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="dsh-setup-flow">
        {error && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="button secondary"
          onClick={() => void loadStatus()}
        >
          <RefreshCw size={12} />
          Check again
        </button>
      </div>
    );
  }

  return (
    <div className="dsh-setup-flow">
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}

      {!status.cliInstalled && (
        <div className="dsh-setup-panel">
          {status.desktopAppPath || status.desktopCli?.desktopAppPath ? (
            <>
              <strong>Install the dsh command from Desktop</strong>
              <p>{cliInstallExplanation()}</p>
              <code className="dsh-setup-path">
                {status.desktopCli?.desktopAppPath ?? status.desktopAppPath}
              </code>
              {(needsDesktopMenu || status.desktopCli?.canInstall === false) && (
                <div className="dsh-setup-warning" role="status">
                  <AlertTriangle size={14} />
                  <div>
                    <strong>Finish from DeepSeek Harness Desktop</strong>
                    <p>
                      Open DeepSeek Harness Desktop and click{" "}
                      <em>Manage dsh Command…</em> in its menu, then click{" "}
                      <strong>Check again</strong>.
                    </p>
                    {(installNote || status.desktopCli?.reason) && (
                      <small>{installNote || status.desktopCli?.reason}</small>
                    )}
                  </div>
                </div>
              )}
              {!needsDesktopMenu && installNote && (
                <p className="connection-error" role="status">
                  {installNote}
                </p>
              )}
              <div className="dsh-setup-actions">
                {status.desktopCli?.canInstall !== false && (
                  <button
                    type="button"
                    className="button primary"
                    disabled={!!busyAction}
                    onClick={() => void installCli()}
                  >
                    {busyAction === "install-cli" ? (
                      <Spinner />
                    ) : (
                      <Sparkles size={12} />
                    )}
                    Install dsh CLI
                  </button>
                )}
                <button
                  type="button"
                  className="button secondary"
                  disabled={!!busyAction || loading}
                  onClick={() => {
                    void onRefreshStatus();
                    void loadStatus();
                  }}
                >
                  <RefreshCw size={12} />
                  Check again
                </button>
              </div>
            </>
          ) : (
            <>
              <strong>DeepSeek Harness is not installed yet</strong>
              <p>
                Install DeepSeek Harness Desktop or the <code>dsh</code> CLI,
                then check again.
              </p>
              <div className="dsh-setup-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    void window.memcode
                      .openWorkerSetup("dsh")
                      .catch((err) => setError((err as Error).message))
                  }
                >
                  <ArrowUpRight size={12} />
                  CLI setup guide
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={loading}
                  onClick={() => {
                    void onRefreshStatus();
                    void loadStatus();
                  }}
                >
                  <RefreshCw size={12} />
                  Check again
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {status.cliInstalled && (
        <div className="dsh-setup-panel">
          <div className="dsh-setup-panel-header">
            <strong>ACP profile</strong>
            <span>
              {status.acpProfiles.length > 0
                ? `${status.acpProfiles.length} ACP profile${status.acpProfiles.length === 1 ? "" : "s"}`
                : "Needs ACP profile"}
            </span>
          </div>

          {status.acpProfiles.length > 0 && (
            <div className="dsh-profile-list" role="group" aria-label="ACP profiles">
              {status.acpProfiles.map((profile) => {
                const isSelected =
                  profile.name === status.activeProfile &&
                  !status.activeProfileIssue;
                return (
                  <button
                    key={profile.name}
                    type="button"
                    className={
                      "dsh-profile-choice" + (isSelected ? " active" : "")
                    }
                    disabled={!!busyAction}
                    onClick={() => void selectProfile(profile.name)}
                  >
                    <span>
                      <strong>{profile.name}</strong>
                      {profile.hasCustomConfig && (
                        <em className="dsh-badge">Custom config</em>
                      )}
                    </span>
                    {busyAction === `select:${profile.name}` ? (
                      <Spinner />
                    ) : isSelected ? (
                      <span className="dsh-profile-active">
                        <Check size={12} /> Active
                      </span>
                    ) : (
                      <span className="dsh-profile-use">Use</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {(status.needsProfileCreation ||
            status.activeProfileIssue === "missing" ||
            status.activeProfileIssue === "non-acp") && (
            <div className="dsh-create-profile">
              <p>
                {status.activeProfileIssue === "non-acp"
                  ? `Profile "${status.activeProfile}" is not configured for ACP. Select an ACP profile above or create one for MemCode workers.`
                  : status.activeProfileIssue === "missing"
                    ? `Profile "${status.activeProfile}" was not found. Select an existing ACP profile or create a new one.`
                    : "No ACP profile was found. DeepSeek Harness Desktop keeps its own profile, while MemCode runs workers through an ACP profile."}
              </p>
              <div className="dsh-create-profile-row">
                <input
                  type="text"
                  aria-label="New ACP profile name"
                  value={profileName}
                  disabled={!!busyAction}
                  onChange={(event) => setProfileName(event.target.value)}
                  placeholder="acp"
                />
                <button
                  type="button"
                  className="button primary"
                  disabled={!profileName.trim() || !!busyAction}
                  onClick={() => void createProfile()}
                >
                  {busyAction === "create-profile" ? <Spinner /> : null}
                  Create ACP profile
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {profileValid && status.desktopProfilePresent && (
        <div className="dsh-setup-panel">
          {diffLoading ? (
            <div className="dsh-setup-inline-status">
              <Spinner />
              <span>Checking DeepSeek Harness Desktop providers…</span>
            </div>
          ) : migrationResult ? (
            <div className="dsh-setup-success" role="status">
              <Check size={14} />
              <span>
                Imported {migrationResult.appliedCount} provider
                {migrationResult.appliedCount === 1 ? "" : "s"} ·{" "}
                {migrationResult.modelCount} model
                {migrationResult.modelCount === 1 ? "" : "s"} verified in{" "}
                <code>{migrationResult.targetProfile}</code>.
              </span>
            </div>
          ) : diff && diff.providers.length > 0 ? (
            <>
              <div className="dsh-setup-panel-header">
                <div>
                  <strong>
                    Sync Desktop providers to “{diff.targetProfile}”
                  </strong>
                  <small>
                    Optional · tested in an isolated dry-run before touching{" "}
                    <code>{diff.targetProfile}</code>.
                  </small>
                </div>
                <div className="dsh-sync-links">
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busyAction}
                    onClick={() =>
                      setSelectedIds(diff.providers.map((item) => item.id))
                    }
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busyAction}
                    onClick={() => setSelectedIds([])}
                  >
                    Select none
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busyAction}
                    onClick={() => {
                      if (alreadyConnected) onClose();
                      else setSkippedSync(true);
                    }}
                  >
                    Skip / Use current models
                  </button>
                </div>
              </div>

              {skippedSync ? (
                <p className="dsh-setup-note">
                  Skipped Desktop import. Using the current models in{" "}
                  <code>{status.activeProfile}</code>.{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setSkippedSync(false)}
                  >
                    Review providers
                  </button>
                </p>
              ) : (
                <>
                  <div className="dsh-provider-list">
                    {diff.providers.map((provider) => {
                      const checked = selectedIds.includes(provider.id);
                      const modelList = provider.missingModels?.length
                        ? provider.missingModels
                        : provider.models;
                      return (
                        <label key={provider.id} className="dsh-provider-row">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!!busyAction}
                            onChange={(event) => {
                              setDryRunResult(null);
                              setSelectedIds((current) =>
                                event.target.checked
                                  ? [...current, provider.id]
                                  : current.filter((id) => id !== provider.id),
                              );
                            }}
                          />
                          <div>
                            <div className="dsh-provider-title">
                              <strong>{provider.name}</strong>
                              <span className="dsh-badge">
                                {provider.kind === "pi-ai"
                                  ? "Custom provider"
                                  : "Plugin"}
                              </span>
                              {provider.source === "local-link" && (
                                <span
                                  className="dsh-badge warn"
                                  title={provider.warning}
                                >
                                  Local link
                                </span>
                              )}
                            </div>
                            <small>
                              {modelList.length > 0
                                ? `${modelList.length} model${modelList.length === 1 ? "" : "s"}: ${modelList.join(", ")}`
                                : provider.providerId}
                            </small>
                            {provider.warning && (
                              <small className="dsh-provider-warning">
                                {provider.warning}
                              </small>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  {diff.skipped.length > 0 && (
                    <details className="dsh-skipped-note">
                      <summary>
                        {diff.skipped.length} Desktop item
                        {diff.skipped.length === 1 ? "" : "s"} not offered for
                        copying
                      </summary>
                      <ul>
                        {diff.skipped.map((item) => (
                          <li key={item.name}>
                            <strong>{item.name}</strong>: {item.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {(busyAction === "migrate" || busyAction === "import") && (
                    <div className="dsh-setup-inline-status" role="status">
                      <Spinner />
                      <span>
                        {busyAction === "migrate"
                          ? "Testing selected providers in an isolated dry-run… Your active profile is unchanged."
                          : `Importing the verified providers into “${diff.targetProfile}”…`}
                      </span>
                    </div>
                  )}

                  {dryRunResult && (!dryRunResult.ok || dryRunResult.failed.length > 0) && (() => {
                    const providerFailures = dryRunResult.failed.filter(
                      (item) => !item.id.startsWith("profile:"),
                    );
                    return (
                      <div className="dsh-setup-warning" role="alert">
                        <AlertTriangle size={14} />
                        <div>
                          <strong>
                            {failure.phase === "dry-run"
                              ? `Dry-run failed — “${dryRunResult.targetProfile}” was not modified`
                              : failure.restored
                                ? `Import failed — “${dryRunResult.targetProfile}” was restored to its previous state`
                                : `Import failed — “${dryRunResult.targetProfile}” may need manual recovery`}
                          </strong>
                          {dryRunResult.failed.length > 0 ? (
                            <ul>
                              {dryRunResult.failed.map((failure) => (
                                <li key={failure.id}>
                                  <strong>{failure.name}</strong>: {failure.reason}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>
                              {dryRunResult.error ||
                                "Selected providers failed when combined. Review your selection and try again."}
                            </p>
                          )}
                          {providerFailures.length > 0 && (
                            <small>
                              Failing providers have been unchecked below.
                            </small>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="dsh-setup-actions">
                    {dryRunResult &&
                    dryRunResult.failed.some((item) => !item.id.startsWith("profile:")) ? (
                      <button
                        type="button"
                        className="button primary"
                        disabled={selectedIds.length === 0 || !!busyAction}
                        onClick={() => void runMigration(selectedIds)}
                      >
                        Retry without broken providers
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button primary"
                        disabled={selectedIds.length === 0 || !!busyAction}
                        onClick={() => void runMigration(selectedIds)}
                      >
                        {busyAction === "migrate" || busyAction === "import" ? <Spinner /> : null}
                        Test &amp; Import Selected
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          ) : diffError ? (
            <div className="dsh-setup-warning" role="alert">
              <AlertTriangle size={14} />
              <div>
                <strong>Desktop providers could not be compared</strong>
                <p>{diffError}</p>
                {skippedSync ? (
                  <small>
                    Skipped Desktop import. Using the current models in{" "}
                    <code>{status.activeProfile}</code>.
                  </small>
                ) : null}
                <div className="dsh-setup-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!!busyAction || diffLoading}
                    onClick={() => void loadDiff(status)}
                  >
                    <RefreshCw size={12} />
                    Retry comparison
                  </button>
                  {!skippedSync && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={!!busyAction}
                      onClick={() => {
                        if (alreadyConnected) onClose();
                        else setSkippedSync(true);
                      }}
                    >
                      Skip / Use current models
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="dsh-setup-note">
              <span>
                All supported Desktop providers are already present in{" "}
                <code>{status.activeProfile}</code>.
              </span>
              {diff && diff.skipped.length > 0 && (
                <details className="dsh-skipped-note">
                  <summary>
                    {diff.skipped.length} Desktop item
                    {diff.skipped.length === 1 ? "" : "s"} skipped
                  </summary>
                  <ul>
                    {diff.skipped.map((item) => (
                      <li key={item.name}>
                        <strong>{item.name}</strong>: {item.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
