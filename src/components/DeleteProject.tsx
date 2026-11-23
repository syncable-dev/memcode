import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { Project } from "../shared";
import { projectDeletionNote } from "../deletion";
import { Modal } from "./Dialogs";
import "../styles-worker-input.css";

/**
 * A project's delete button in the project switcher, and the confirmation it opens.
 * Deleting removes the project from MemCode on this computer; its folder stays.
 */
export function DeleteProject({
  project,
  shared,
  onDeleted,
}: {
  project: Project;
  /** Shared through MemSync: it stays shared for everyone else. */
  shared: boolean;
  onDeleted(): void;
}) {
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
          kicker="REMOVE FROM MEMCODE"
          description={
            project.example
              ? "Example project"
              : shared
                ? "Shared project"
                : "Personal project"
          }
          close={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <div className="modal-body">
            <p className="delete-explanation">
              {projectDeletionNote(project, shared)}
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
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? "Deleting…" : "Delete project"}
              </button>
            </div>
          </footer>
        </Modal>
      )}
    </>
  );
}
