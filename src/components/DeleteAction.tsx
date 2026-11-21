import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal } from "./Dialogs";
import "../styles-worker-input.css";

export function DeleteAction({
  kind,
  id,
  name,
  disabled,
  compact,
  withChildren,
  onDeleted,
}: {
  kind: "story" | "epic" | "cycle";
  id: string;
  name: string;
  disabled?: boolean;
  compact?: boolean;
  withChildren?: boolean;
  onDeleted?: () => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [cascade, setCascade] = useState(false),
    [error, setError] = useState("");
  const label =
    kind === "story" ? "task" : kind === "epic" ? "goal" : "cycle";
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await (kind === "story"
        ? window.memcode.deleteStory(id, cascade)
        : kind === "epic"
          ? window.memcode.deleteEpic(id)
          : window.memcode.deleteCycle(id));
      setConfirm(false);
      onDeleted?.();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className={compact ? "icon-button delete-action" : "delete-action"}
        disabled={disabled}
        aria-label={`Delete ${label}`}
        title={
          disabled
            ? "Stop the active workers before deleting"
            : `Delete ${label}`
        }
        onClick={(event) => {
          event.stopPropagation();
          setConfirm(true);
        }}
      >
        <Trash2 size={14} />
        {!compact && `Delete ${label}`}
      </button>
      {confirm && (
        <Modal
          title={`Delete this ${label}?`}
          kicker="REMOVE FROM WORKSPACE"
          description={name}
          close={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <div className="modal-body">
            <p className="delete-explanation">
              {kind === "story"
                ? "This removes the task, its conversation and saved review notes from MemCode. Source files, Git history and output files remain on disk."
                : kind === "epic"
                  ? "Its tasks move to Project work. Their conversations, code and outputs are preserved."
                  : "Its tasks return to the backlog. This cycle and its chart history are removed."}
            </p>
            {withChildren && (
              <label className="delete-children">
                <input
                  type="checkbox"
                  checked={cascade}
                  onChange={(e) => setCascade(e.target.checked)}
                />{" "}
                Also delete its subtasks
              </label>
            )}
            {error && (
              <p role="alert" className="worker-input-error">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <span>This action removes saved workspace data.</span>
            <div className="delete-confirm-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Keep {label}
              </button>
              <button
                className="button delete-confirm"
                disabled={busy || (!!withChildren && !cascade)}
                onClick={() => void remove()}
              >
                {busy ? "Deleting…" : `Delete ${label}`}
              </button>
            </div>
          </footer>
        </Modal>
      )}
    </>
  );
}
