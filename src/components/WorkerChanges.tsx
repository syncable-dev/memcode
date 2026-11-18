import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Code2,
  FileCode2,
  GitBranch,
  Plus,
  Minus,
  ShieldCheck,
} from "lucide-react";
import type { WorkItem } from "../shared";
import { harnessNames } from "../shared";
import type {
  WorkerChanges as Changes,
  ChangeCheckpoint,
  ChangeFile,
} from "../changes";
import { Empty, Spinner, HarnessMark } from "./UI";
import "../styles-changes.css";
import { SelectionActions } from "./SelectionActions";
import { useReviewSelection } from "./useReviewSelection";
import type { ReviewReference, ReviewComment } from "../review";
import { ReviewHighlights } from "./ReviewHighlights";
const HighlightedPatch = lazy(() => import("./HighlightedPatch"));

export function WorkerChanges({
  task,
  onComment,
  comments,
  focusedCommentId,
  focusVersion,
  onFocusComment,
  focusTarget,
}: {
  task: WorkItem;
  onComment: (reference: ReviewReference) => void;
  comments: ReviewComment[];
  focusedCommentId?: string;
  focusVersion?: number;
  onFocusComment: (id: string) => void;
  focusTarget?: {
    id: string;
    path?: string;
    line?: number;
    checkpointId?: string;
  };
}) {
  const [changes, setChanges] = useState<Changes>(),
    [error, setError] = useState(""),
    [selected, setSelected] = useState("");
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusTarget?.path) setSelected(focusTarget.path);
  }, [focusTarget?.id]);
  useEffect(() => {
    if (!focusTarget?.path || selected !== focusTarget.path || !changes) return;
    const rootElement = root.current;
    if (!rootElement) return;
    const matching = changes.checkpoints.filter((item) =>
      item.files.some((file) => file.path === selected),
    );
    // A net review finding names final source lines. Multiple intermediate
    // checkpoints may reuse that line number for different code; only jump to
    // an exact diff line when its checkpoint is explicit or unambiguous.
    const checkpointId =
      focusTarget.checkpointId ??
      (matching.length === 1 ? matching[0].id : undefined);
    let frame = 0;
    const focus = () => {
      const checkpoint = checkpointId
        ? rootElement.querySelector<HTMLElement>(
            `[data-checkpoint="${CSS.escape(checkpointId)}"]`,
          )
        : rootElement.querySelector<HTMLElement>(".change-file-content");
      const line =
        focusTarget.line && checkpointId
          ? checkpoint?.querySelector<HTMLElement>(
              `[data-new-line="${focusTarget.line}"]`,
            )
          : checkpoint;
      if (line) {
        line.scrollIntoView({ block: "center", behavior: "smooth" });
        line.classList.add("code-review-source-focus");
      }
    };
    // Syntax highlighting is lazy; one short observer also covers its first paint.
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(focus);
    });
    observer.observe(rootElement, { childList: true, subtree: true });
    frame = requestAnimationFrame(focus);
    const timeout = setTimeout(() => observer.disconnect(), 1800);
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      rootElement
        .querySelectorAll(".code-review-source-focus")
        .forEach((node) => node.classList.remove("code-review-source-focus"));
    };
  }, [focusTarget?.id, selected, changes]);
  useEffect(() => {
    const path = comments.find((comment) => comment.id === focusedCommentId)
      ?.reference.path;
    if (path) setSelected(path);
  }, [focusedCommentId, focusVersion]);
  const [selection, setSelection] = useReviewSelection(root, (value) => {
    const nodes = [value.anchorNode, value.focusNode].map((node) =>
        (node instanceof Element
          ? node
          : node?.parentElement
        )?.closest<HTMLElement>(".change-line"),
      ),
      before = nodes.some((node) => node?.dataset.kind === "delete"),
      after = nodes.some((node) => node?.dataset.kind !== "delete"),
      numbers = nodes
        .map((node) =>
          Number(
            before && !after ? node?.dataset.oldLine : node?.dataset.newLine,
          ),
        )
        .filter(Boolean),
      checkpoint =
        nodes[0]?.closest<HTMLElement>("[data-checkpoint]")?.dataset.checkpoint;
    return {
      kind: "changes",
      selectionType: "lines",
      taskId: task.id,
      name: selected,
      path: selected,
      quote: value.toString().trim().slice(0, 4000),
      side: before ? (after ? "mixed" : "before") : "after",
      ...(numbers.length
        ? { lineStart: Math.min(...numbers), lineEnd: Math.max(...numbers) }
        : {}),
      checkpointId: checkpoint,
    };
  });
  useEffect(() => setSelection(undefined), [selected, task.id]);
  useEffect(() => {
    let alive = true;
    void window.memcode
      .workerChanges(task.id)
      .then((value) => {
        if (alive) {
          setError("");
          setChanges(value);
          setSelected((path) =>
            value.checkpoints.some((c) => c.files.some((f) => f.path === path))
              ? path
              : (value.checkpoints[0]?.files[0]?.path ?? ""),
          );
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [task.id, task.changesRevision, task.run.state, task.run.sessionId]);
  if (error)
    return (
      <div className="changes-error" role="alert">
        {error}
      </div>
    );
  if (!changes || changes.taskId !== task.id)
    return (
      <div className="changes-loading">
        <Spinner />
      </div>
    );
  const paths = [
    ...new Set(changes.checkpoints.flatMap((c) => c.files.map((f) => f.path))),
  ];
  if (!paths.length)
    return (
      <Empty
        icon={<Code2 size={27} />}
        title="Changes, connected to their worker."
        description="Files and line changes appear here as this worker records edits."
      />
    );
  const groups = changes.checkpoints.flatMap((checkpoint) =>
    checkpoint.files
      .filter((file) => file.path === selected)
      .map((file) => ({ checkpoint, file })),
  );
  return (
    <section ref={root} className="worker-changes" aria-label="Worker changes">
      <header className="worker-changes-summary">
        <HarnessMark id={task.harness} small />
        <strong>{harnessNames[task.harness]}’s changes</strong>
        <span>
          {changes.files} {changes.files === 1 ? "file" : "files"}
        </span>
        <b className="change-added">+{changes.additions}</b>
        <b className="change-deleted">−{changes.deletions}</b>
        <small>
          <GitBranch size={11} />
          {task.run.branch}
        </small>
        <SelectionActions selection={selection} onComment={onComment} />
      </header>
      <div className="changes-layout">
        <nav className="changed-files" aria-label="Changed files">
          {paths.map((path) => {
            const entries = changes.checkpoints.flatMap((c) =>
              c.files.filter((f) => f.path === path),
            );
            return (
              <button
                key={path}
                className={path === selected ? "active" : ""}
                onClick={() => setSelected(path)}
                title={path}
              >
                <FileCode2 size={13} />
                <span>{path}</span>
                <b className="change-added">
                  +{entries.reduce((n, f) => n + f.additions, 0)}
                </b>
                <b className="change-deleted">
                  −{entries.reduce((n, f) => n + f.deletions, 0)}
                </b>
              </button>
            );
          })}
        </nav>
        <div className="change-file-content">
          <FilePatches
            key={selected}
            groups={groups}
            onLine={(quote, line, side, checkpointId) => {
              setSelection({
                kind: "changes",
                taskId: task.id,
                name: selected,
                path: selected,
                quote: quote || "(empty line)",
                lineStart: line,
                lineEnd: line,
                side,
                checkpointId,
              });
            }}
          />
        </div>
      </div>
      <footer className="changes-footer">
        <ShieldCheck size={11} />
        {changes.checkpoints.some((c) => c.basis === "scoped-baseline")
          ? "Earlier run · scoped source snapshot"
          : changes.checkpoints.some((c) => c.basis.startsWith("native-"))
            ? "Includes confirmed Claude Code edits"
            : "Recorded at this worker’s Fleet checkpoints"}
        <span>Review candidate</span>
      </footer>
      <ReviewHighlights
        comments={comments.filter(
          (comment) => comment.reference.path === selected,
        )}
        root={root}
        focusedId={focusedCommentId}
        focusVersion={focusVersion}
        onFocus={onFocusComment}
      />
    </section>
  );
}
function FilePatches({
  groups,
  onLine,
}: {
  groups: Array<{ checkpoint: ChangeCheckpoint; file: ChangeFile }>;
  onLine: (
    quote: string,
    line: number,
    side: "before" | "after",
    checkpointId: string,
  ) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (
        event.shiftKey &&
        event.deltaY &&
        !event.deltaX &&
        element.scrollWidth > element.clientWidth
      ) {
        element.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  if (!groups.length) return null;
  const file = groups[0].file;
  return (
    <article className="file-patch">
      <header>
        <FileCode2 size={14} />
        <strong>{file.path}</strong>
        <span className={"change-status " + file.status}>{file.status}</span>
        <b className="change-added">
          +{groups.reduce((n, g) => n + g.file.additions, 0)}
        </b>
        <b className="change-deleted">
          −{groups.reduce((n, g) => n + g.file.deletions, 0)}
        </b>
      </header>
      <div
        className="change-patch-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="Scrollable code changes"
      >
        <div className="change-code">
          {groups.map(({ checkpoint, file }) => (
            <div key={checkpoint.id} data-checkpoint={checkpoint.id}>
              {groups.length > 1 && (
                <div className="change-checkpoint-label">
                  {checkpoint.basis.startsWith("native-") ? "Edit" : "Checkpoint"} ·{" "}
                  {new Date(checkpoint.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </div>
              )}
              {file.binary ? (
                <p className="binary-change">Binary file changed.</p>
              ) : (
                file.hunks.map((hunk, index) => (
                  <div className="change-hunk" key={index}>
                    <div className="change-hunk-heading">
                      @@ −{hunk.oldStart} +{hunk.newStart} @@
                    </div>
                    <Suspense
                      fallback={
                        <div className="changes-loading">
                          <Spinner />
                        </div>
                      }
                    >
                      <HighlightedPatch
                        path={file.path}
                        hunk={hunk}
                        onLine={(line) =>
                          onLine(
                            line.text,
                            line.kind === "delete"
                              ? line.oldLine!
                              : line.newLine!,
                            line.kind === "delete" ? "before" : "after",
                            checkpoint.id,
                          )
                        }
                      />
                    </Suspense>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
