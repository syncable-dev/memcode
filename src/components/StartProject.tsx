import { ArrowRight, FolderOpen, FolderPlus } from "lucide-react";
import { Mark } from "./UI";
import "../styles-start-project.css";

/**
 * What the workspace shows when no project of the person's own is left: start
 * one from a folder they have, start a new one, or look around the example.
 */
export function StartProject({
  start,
  explore,
}: {
  start: (mode: "existing" | "new") => void;
  explore: () => void;
}) {
  return (
    <section className="start-project" aria-labelledby="start-project-title">
      <div className="start-project-inner">
        <span className="start-project-mark">
          <Mark />
        </span>
        <p className="start-project-eyebrow">YOUR WORKSPACE</p>
        <h1 id="start-project-title">Start your next project.</h1>
        <p className="start-project-lead">
          Open a folder you already work in, or begin a new one. Memtrace reads
          the code on this computer, so every task starts with the right context.
        </p>
        <div className="start-project-options">
          <button type="button" onClick={() => start("existing")}>
            <span className="start-project-icon">
              <FolderOpen size={19} />
            </span>
            <span>
              <strong>Open a folder</strong>
              <small>A repository you already have</small>
            </span>
            <ArrowRight size={15} />
          </button>
          <button type="button" onClick={() => start("new")}>
            <span className="start-project-icon">
              <FolderPlus size={19} />
            </span>
            <span>
              <strong>Start something new</strong>
              <small>A fresh folder, ready for a first goal</small>
            </span>
            <ArrowRight size={15} />
          </button>
        </div>
        <button type="button" className="start-project-explore" onClick={explore}>
          Look around the example first
        </button>
      </div>
    </section>
  );
}
