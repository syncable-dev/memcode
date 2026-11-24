import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { Project } from "../shared";
import type { ProjectSharing } from "../sharing";
import { projectDeletionLabels, projectDeletionNote } from "../deletion";
import { Modal } from "./Dialogs";
import "../styles-worker-input.css";

/**
 * A project's delete button in the project switcher, and the confirmation it opens.
 * Deleting removes the project from MemCode on this computer; its folder stays. A
 * shared project's owner deletes it for everyone; anyone else leaves it.
 */
export function DeleteProject({
  project,
  sharing,
  hasInbox,
  onDeleted,
}: {
  project: Project;
  /** Whom else deleting it reaches, which the confirmation names. */
  sharing: ProjectSharing;
  /** Whether an Inbox of its own goes with it. */
  hasInbox: boolean;
  onDeleted(): void;
}) {
  const labels = projectDeletionLabels(sharing);
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await window.memcode.deleteProject(project.id);
      setConfirm(false);
      onDeleted();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="icon-button project-delete"
        aria-label={`Delete ${project.name}`}
        title={`Delete ${project.name}`}
        onClick={(event) => {
          event.stopPropagation();
          setConfirm(true);
        }}
      >
        <Trash2 size={13} />
      </button>
      {confirm && (
        <Modal
          title={`Delete ${project.name}?`}
          kicker={labels.kicker}
          description={labels.description}
          close={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <div className="modal-body">
            <p className="delete-explanation">
              {projectDeletionNote(project, sharing, hasInbox)}
            </p>
            {error && (
              <p role="alert" className="worker-input-error">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <span>This can't be undone.</span>
            <div className="delete-confirm-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Keep project
              </button>
              <button
                className="button delete-confirm"
                disabled={busy || !labels.canConfirm}
                onClick={() => void remove()}
              >
                {busy ? "Deleting…" : labels.confirm}
              </button>
            </div>
          </footer>
        </Modal>
      )}
    </>
  );
}
