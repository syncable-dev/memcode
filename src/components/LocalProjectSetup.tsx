import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  FolderOpen,
  GitBranch,
  Link2,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Project } from "../shared";
import type { LocalAnalysisDiagnostics } from "../local-analysis";
import { sourceChangedBeforePublication } from "../local-analysis";
import type {
  RepositoryAccess,
  RepositoryDescriptor,
  RepositoryGitHubSignIn,
  RepositoryInspection,
  RepositoryProgress,
} from "../repository";
import "../styles-repository.css";

interface Props {
  project: Project;
  repository?: RepositoryDescriptor;
  notify: (message: string) => void;
  onWorkers: () => void;
}

export function LocalProjectSetup({
  project,
  repository,
  notify,
  onWorkers,
}: Props) {
  const [inspection, setInspection] = useState<RepositoryInspection | null>(
    null,
  );
  const [checkouts, setCheckouts] = useState<RepositoryInspection[]>([]);
  const [access, setAccess] = useState<RepositoryAccess | null>(null);
  const [signin, setSignin] = useState<RepositoryGitHubSignIn | null>(null);
  const [progress, setProgress] = useState<RepositoryProgress | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [parent, setParent] = useState("");
  const [name, setName] = useState(repository?.name ?? project.name);
  const [busy, setBusy] = useState("");
  const [recovering, setRecovering] = useState(true);
  const [cloneActive, setCloneActive] = useState(false);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] =
    useState<LocalAnalysisDiagnostics | null>(null);
  const diagnosticScope = `${project.id}\0${project.path ?? ""}\0${project.branch}`;
  const currentDiagnosticScope = useRef(diagnosticScope);
  const diagnosticRequest = useRef<{
    scope: string;
    promise: Promise<LocalAnalysisDiagnostics>;
  } | null>(null);
  currentDiagnosticScope.current = diagnosticScope;
  const revision = diagnostics?.indexRevision;
  const sourceLabel = diagnostics?.failures.some(
    (failure) => failure.operation === "get_query_revision",
  )
    ? "Unknown"
    : typeof revision?.branch === "string" &&
        revision.branch !== diagnostics?.project.branch
      ? "Branch mismatch"
      : diagnostics?.sourcePublication === "verified"
        ? "Aligned"
        : revision
          ? "Not yet verified"
          : "Unknown";
  const cloning = busy === "clone" || cloneActive;
  const blocked = !!busy || recovering || cloneActive;
  const connected = !!project.path || !!inspection;
  const analyzing = ["connecting", "indexing"].includes(project.analysis);
  const publicationRefused =
    project.analysis === "error" &&
    sourceChangedBeforePublication(project.analysisNote);
  const source = repository ?? inspection?.repository;
  const perform = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Local setup could not finish. Please retry.",
      );
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    let live = true;
    setInspection(null);
    setCheckouts([]);
    setAccess(null);
    setSignin(null);
    setProgress(null);
    setParent("");
    setName(repository?.name ?? project.name);
    setCloneOpen(false);
    setCloneActive(false);
    setRecovering(true);
    setError("");
    setDiagnostics(null);
    setBusy((value) => (value === "diagnostics" ? "" : value));
    // Cloning belongs to the runtime, not this mounted view. Leaving Team or
    // closing this panel must not lose the running job or its Cancel action.
    void window.memcode
      .repositorySetupStatus(project.id)
      .then((value) => {
        if (!live) return;
        setRecovering(false);
        if (!value) return;
        if (
          ["checking", "cloning"].includes(value.phase) ||
          (value.phase === "ready" && !project.path)
        ) {
          setProgress(value);
          setCloneActive(true);
          setCloneOpen(true);
        } else if (
          !project.path &&
          ["failed", "cancelled"].includes(value.phase)
        ) {
          setProgress(value);
          setCloneOpen(true);
          setError(value.message);
        }
      })
      .catch(() => {
        if (live)
          setError(
            "Could not check existing repository setup. Reopen local setup to retry before cloning.",
          );
      });
    if (project.path)
      void window.memcode
        .inspectProjectRepository(project.id)
        .then((value) => {
          if (live) setInspection(value);
        })
        .catch((reason) => {
          if (live)
            setError(
              reason instanceof Error
                ? reason.message
                : "Local folder could not be inspected.",
            );
        });
    else if (repository)
      void window.memcode
        .findProjectCheckouts(repository)
        .then((value) => {
          if (live) setCheckouts(value);
        })
        .catch(() => {
          /* The folder picker remains available if discovery fails. */
        });
    return () => {
      live = false;
    };
  }, [project.id, project.path, project.branch, repository?.identity]);

  useEffect(() => {
    if (!cloning) return;
    let live = true,
      pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await window.memcode.repositorySetupStatus(project.id);
        if (!live || !value) return;
        setProgress(value);
        if (["checking", "cloning"].includes(value.phase)) setCloneActive(true);
        else if (value.phase === "failed" || value.phase === "cancelled") {
          setCloneActive(false);
          setError(value.message);
        } else if (value.phase === "ready") {
          // The clone can finish before its local project binding is saved.
          // Keep watching that existing job until the checkout is accessible.
          const inspected = await window.memcode.inspectProjectRepository(
            project.id,
          );
          if (live) {
            setInspection(inspected);
            setCloneActive(false);
            setCloneOpen(false);
          }
        }
      } catch {
        /* A brief binding transition is retried without starting a new clone. */
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 700);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [cloning, project.id]);

  useEffect(() => {
    if (signin?.state !== "waiting") return;
    let live = true,
      pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void window.memcode
        .githubRepositorySignIn("status")
        .then(async (value) => {
          if (!live) return;
          setSignin(value);
          if (value.state === "signed-in" && source) {
            const checked = await window.memcode.repositoryAccess(source);
            if (live) setAccess(checked);
          }
        })
        .catch((reason) => {
          if (live) {
            setSignin(null);
            setError(
              reason instanceof Error
                ? reason.message
                : "Check your GitHub connection and retry.",
            );
          }
        })
        .finally(() => {
          pending = false;
        });
    }, 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [signin?.state, source?.identity]);

  const finishConnection = async (value: Project) => {
    setCloneOpen(false);
    setProgress(null);
    setInspection(await window.memcode.inspectProjectRepository(value.id));
    notify("Local code connected to this shared project");
  };
  const checkDiagnostics = useCallback(
    async (background = false) => {
      const scope = diagnosticScope;
      if (!background) {
        setBusy("diagnostics");
        setError("");
      }
      let request = diagnosticRequest.current;
      if (request?.scope !== scope) {
        request = {
          scope,
          promise: window.memcode.localAnalysisDiagnostics(project.id),
        };
        diagnosticRequest.current = request;
      }
      try {
        const value = await request.promise;
        if (currentDiagnosticScope.current === scope) {
          setDiagnostics(value);
          return value;
        }
      } catch (reason) {
        if (!background && currentDiagnosticScope.current === scope)
          setError(
            reason instanceof Error
              ? reason.message
              : "Local engine diagnostics could not be read.",
          );
      } finally {
        if (diagnosticRequest.current === request)
          diagnosticRequest.current = null;
        if (!background && currentDiagnosticScope.current === scope)
          setBusy("");
      }
    },
    [diagnosticScope, project.id],
  );
  useEffect(() => {
    if (!publicationRefused || !project.path) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 120_000;
    const check = async () => {
      const report = await checkDiagnostics(true);
      if (
        !stopped &&
        report?.sourcePublication === "incomplete" &&
        Date.now() + 5_000 <= deadline
      )
        timer = setTimeout(check, 5_000);
    };
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [publicationRefused, project.path, checkDiagnostics]);
  const bind = (path: string) =>
    void perform("folder", async () =>
      finishConnection(
        await window.memcode.bindProjectFolder(project.id, path),
      ),
    );
  const pickExisting = () =>
    void perform("folder", async () => {
      const path = await window.memcode.selectFolder();
      if (path)
        await finishConnection(
          await window.memcode.bindProjectFolder(project.id, path),
        );
    });
  const checkAccess = () =>
    source &&
    void perform("access", async () =>
      setAccess(await window.memcode.repositoryAccess(source)),
    );
  const clone = () =>
    source &&
    !blocked &&
    void perform("clone", async () => {
      setProgress({
        phase: "checking",
        message: "Checking repository access…",
      });
      await finishConnection(
        await window.memcode.cloneProjectRepository({
          projectId: project.id,
          repository: source,
          parent,
          name: name.trim(),
        }),
      );
    });

  return (
    <section className="repo-setup" aria-label="Connect local code">
      <header className="repo-setup-header">
        <span className="repo-setup-symbol">
          <HardDrive size={19} />
        </span>
        <div>
          <span className="repo-kicker">ON THIS COMPUTER</span>
          <h3>
            {connected ? "Your local workspace." : "Ready to work on the code?"}
          </h3>
          <p>
            {connected
              ? "A private checkout connected to the shared project."
              : "The shared board is ready. Choose where the project’s code lives on this computer."}
          </p>
        </div>
      </header>
      <ol className="repo-setup-steps" aria-label="Project setup progress">
        <li className="complete">
          <Check size={12} />
          <span>Shared project</span>
        </li>
        <li className={connected ? "complete" : "current"}>
          {connected ? (
            <Check size={12} />
          ) : (
            <span className="repo-step-number">2</span>
          )}
          <span>Local code</span>
        </li>
        <li className={connected ? "current" : ""}>
          <span className="repo-step-number">3</span>
          <span>Connect a worker</span>
        </li>
      </ol>
      {source && (
        <div className="repo-source">
          <GitBranch size={15} />
          <span>{source.identity}</span>
          {source.defaultBranch && <small>{source.defaultBranch}</small>}
        </div>
      )}
      {error && (
        <p className="repo-error" role="alert">
          {error}
        </p>
      )}

      {connected ? (
        <div className="repo-connected">
          <div className="repo-connected-heading">
            <CheckCircle2 size={17} />
            <strong>Local code connected</strong>
            {inspection?.dirty && (
              <span className="repo-badge">Local changes preserved</span>
            )}
          </div>
          <p
            className="repo-local-path"
            title={inspection?.path ?? project.path ?? ""}
          >
            {inspection?.path ?? project.path}
          </p>
          {inspection && (
            <div className="repo-checkout-details">
              <span>
                <GitBranch size={12} />
                {inspection.branch}
              </span>
              {inspection.revision && (
                <code>{inspection.revision.slice(0, 8)}</code>
              )}
              <span>
                {inspection.dirty ? "Uncommitted changes" : "Clean checkout"}
              </span>
            </div>
          )}
          <div
            className={`repo-analysis ${project.analysis === "error" ? "needs-attention" : ""}`}
          >
            <span>
              {analyzing ? (
                <LoaderCircle size={15} className="repo-spin" />
              ) : (
                <ShieldCheck size={15} />
              )}
            </span>
            <div>
              <strong>
                {analyzing
                  ? "Memtrace is understanding your local code…"
                  : project.analysis === "ready"
                    ? "Code context is ready"
                    : project.analysis === "error"
                      ? "Code analysis needs attention"
                      : "Prepare the context for your workers"}
              </strong>
              <p>
                {publicationRefused
                  ? "The source changed during verification. Once edits settle, retry analysis to verify the current checkout."
                  : (project.analysisNote ??
                    "Memtrace analyzes this checkout locally so workers can explore and route the work with context.")}
              </p>
            </div>
          </div>
          <div className="repo-health-actions">
            <button
              className="repo-text-button"
              style={{ marginLeft: 0 }}
              disabled={!!busy}
              onClick={() => void checkDiagnostics()}
            >
              {busy === "diagnostics" ? (
                <LoaderCircle size={13} className="repo-spin" />
              ) : (
                <ShieldCheck size={13} />
              )}{" "}
              Check local engine
            </button>
            {diagnostics && (
              <button
                className="repo-text-button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(JSON.stringify(diagnostics, null, 2))
                    .then(() => notify("Local engine diagnostics copied"))
                    .catch(() =>
                      setError(
                        "The report could not be copied. Check clipboard access and retry.",
                      ),
                    )
                }
              >
                <Copy size={13} />
                Copy diagnostics
              </button>
            )}
          </div>
          {diagnostics && (
            <section
              className="repo-health"
              aria-label="Local engine diagnostics"
            >
              <dl>
                <div>
                  <dt>Source and index</dt>
                  <dd>{sourceLabel}</dd>
                </div>
                <div>
                  <dt>Local watch</dt>
                  <dd>
                    {diagnostics.failures.some(
                      (failure) => failure.operation === "list_watched_paths",
                    )
                      ? "Unknown"
                      : diagnostics.watch.length
                        ? "Observed on this checkout"
                        : "Not observed"}
                  </dd>
                </div>
                <div>
                  <dt>Matching jobs</dt>
                  <dd>
                    {diagnostics.failures.some(
                      (failure) => failure.operation === "list_jobs",
                    )
                      ? "Unknown"
                      : diagnostics.jobs.length
                        ? diagnostics.jobs
                            .map((job) => String(job.status ?? "unknown"))
                            .join(", ")
                        : "None reported"}
                  </dd>
                </div>
              </dl>
              {typeof diagnostics.indexRevision?.reason === "string" && (
                <p>{diagnostics.indexRevision.reason.replaceAll("_", " ")}</p>
              )}
              {diagnostics.failures.map((failure) => (
                <p key={failure.operation}>
                  {failure.operation}: {failure.reason}
                </p>
              ))}
              <small>
                Checked {new Date(diagnostics.capturedAt).toLocaleTimeString()}.
                Copy includes local paths and engine metadata. Source code and
                credentials are excluded.
              </small>
            </section>
          )}
          <div className="repo-actions">
            <button
              className="button secondary"
              disabled={blocked || analyzing}
              onClick={() =>
                void perform("analysis", () =>
                  window.memcode.analyzeProject(project.id),
                )
              }
            >
              {busy === "analysis" ? (
                <LoaderCircle size={14} className="repo-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {project.analysis === "ready"
                ? "Refresh code context"
                : publicationRefused
                  ? "Retry analysis"
                  : "Analyze local code"}
            </button>
            <button className="button primary" onClick={onWorkers}>
              Connect your worker
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      ) : (
        <>
          {checkouts.length > 0 && (
            <div className="repo-existing">
              <span className="repo-kicker">ALREADY ON THIS COMPUTER</span>
              {checkouts.map((checkout) => (
                <div className="repo-existing-row" key={checkout.path}>
                  <FolderOpen size={18} />
                  <div>
                    <strong>{checkout.path.split(/[\\/]/).at(-1)}</strong>
                    <span className="repo-local-path" title={checkout.path}>
                      {checkout.path}
                    </span>
                    <small>
                      {checkout.branch}
                      {checkout.dirty
                        ? " · local changes preserved"
                        : " · clean checkout"}
                    </small>
                  </div>
                  <button
                    className="button secondary"
                    disabled={blocked}
                    onClick={() => bind(checkout.path)}
                  >
                    Use this folder
                    <ArrowRight size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!cloneOpen ? (
            <div className="repo-options">
              <button
                className="repo-option"
                disabled={blocked}
                onClick={pickExisting}
              >
                <FolderOpen size={21} />
                <span>
                  <strong>Use an existing checkout</strong>
                  <small>
                    Choose its folder. Keep your branch and local changes.
                  </small>
                </span>
                <ArrowRight size={16} />
              </button>
              {source && (
                <button
                  className="repo-option"
                  disabled={blocked}
                  onClick={() => setCloneOpen(true)}
                >
                  <GitBranch size={21} />
                  <span>
                    <strong>Clone the repository</strong>
                    <small>Get the code in a new folder you choose.</small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              )}
            </div>
          ) : (
            <div className="repo-clone">
              <div className="repo-clone-heading">
                <h4>Clone into a new local folder</h4>
                <button
                  className="icon-button"
                  aria-label="Close clone setup"
                  disabled={blocked}
                  onClick={() => setCloneOpen(false)}
                >
                  <X size={15} />
                </button>
              </div>
              <p>
                MemCode uses this computer’s Git credentials. Connect GitHub
                only if access needs it.
              </p>
              <div
                className={`repo-access ${access?.state === "ready" ? "ready" : ""}`}
              >
                <span>
                  {access?.state === "ready" ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <ShieldCheck size={17} />
                  )}
                </span>
                <div>
                  <strong>
                    {access?.state === "ready"
                      ? "Repository access confirmed"
                      : access
                        ? "Check repository access"
                        : "Your repository connection"}
                  </strong>
                  <p>
                    {access?.message ??
                      "Existing SSH keys or Git credentials work here too."}
                  </p>
                  {access?.accountLabel && (
                    <small>
                      GitHub · {access.accountLabel}
                      {access.writeAccess === false ? " · read access" : ""}
                    </small>
                  )}
                </div>
                <button
                  className="button secondary"
                  disabled={blocked || signin?.state === "waiting"}
                  onClick={checkAccess}
                >
                  {busy === "access" ? (
                    <LoaderCircle size={13} className="repo-spin" />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  {access ? "Check again" : "Check access"}
                </button>
              </div>
              {source?.provider === "github" &&
                access &&
                access.state !== "ready" &&
                access.state !== "offline" && (
                  <div className="repo-signin">
                    {signin?.state === "waiting" ? (
                      <>
                        <LoaderCircle size={16} className="repo-spin" />
                        <div>
                          <strong>Finish connecting in your browser</strong>
                          <p>{signin.message}</p>
                          {signin.userCode && (
                            <button
                              className="repo-device-code"
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(signin.userCode!)
                                  .then(() => notify("GitHub code copied"))
                                  .catch(() =>
                                    setError(
                                      "Select and copy the code manually.",
                                    ),
                                  )
                              }
                            >
                              <code>{signin.userCode}</code>
                              <Copy size={13} />
                              <span>Copy code</span>
                            </button>
                          )}
                          {signin.verificationUrl && (
                            <button
                              className="repo-auth-link"
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(signin.verificationUrl!)
                                  .then(() =>
                                    notify("GitHub sign-in link copied"),
                                  )
                                  .catch(() =>
                                    setError(
                                      "Open github.com/login/device in your browser.",
                                    ),
                                  )
                              }
                            >
                              github.com/login/device
                              <Copy size={11} />
                            </button>
                          )}
                        </div>
                        <button
                          className="button secondary"
                          onClick={() =>
                            void perform("signin-cancel", async () =>
                              setSignin(
                                await window.memcode.githubRepositorySignIn(
                                  "cancel",
                                ),
                              ),
                            )
                          }
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <Link2 size={18} />
                        <div>
                          <strong>Connect an account with access</strong>
                          <p>
                            Use GitHub’s official browser sign-in. Your Memtrace
                            account stays separate.
                          </p>
                          {signin?.state === "failed" && (
                            <small>{signin.message}</small>
                          )}
                        </div>
                        <button
                          className="button secondary"
                          disabled={blocked}
                          onClick={() =>
                            void perform("signin", async () =>
                              setSignin(
                                await window.memcode.githubRepositorySignIn(
                                  "start",
                                ),
                              ),
                            )
                          }
                        >
                          Connect GitHub
                          <ArrowRight size={13} />
                        </button>
                      </>
                    )}
                  </div>
                )}
              <div className="repo-destination">
                <label>
                  <span>Save inside</span>
                  <button
                    className="repo-folder-picker"
                    aria-label="Choose clone destination"
                    disabled={blocked}
                    onClick={() =>
                      void perform("destination", async () => {
                        const selected = await window.memcode.selectFolder();
                        if (selected) setParent(selected);
                      })
                    }
                  >
                    <FolderOpen size={15} />
                    <span title={parent}>
                      {parent || "Choose a folder on this computer"}
                    </span>
                  </button>
                </label>
                <label>
                  <span>New folder name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={blocked}
                    maxLength={100}
                    spellCheck={false}
                  />
                </label>
              </div>
              {progress && (
                <div className="repo-progress" role="status">
                  {["checking", "cloning"].includes(progress.phase) ? (
                    <LoaderCircle size={15} className="repo-spin" />
                  ) : (
                    <CheckCircle2 size={15} />
                  )}
                  <span>{progress.message}</span>
                  {cloning && (
                    <button
                      className="repo-text-button"
                      onClick={() =>
                        void window.memcode
                          .cancelRepositorySetup(project.id)
                          .catch((reason) =>
                            setError(
                              reason instanceof Error
                                ? reason.message
                                : "Could not cancel repository setup.",
                            ),
                          )
                      }
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}
              <div className="repo-actions">
                <small>Project setup scripts won’t run during cloning.</small>
                <button
                  className="button primary"
                  disabled={
                    blocked ||
                    access?.state !== "ready" ||
                    !parent ||
                    !name.trim()
                  }
                  onClick={clone}
                >
                  {cloning ? (
                    <LoaderCircle size={14} className="repo-spin" />
                  ) : (
                    <GitBranch size={14} />
                  )}
                  Clone and connect
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <footer className="repo-privacy">
        <ShieldCheck size={13} />
        <span>
          Code, analysis and workers stay local. Your team shares the board and
          the results you publish.
        </span>
      </footer>
    </section>
  );
}
