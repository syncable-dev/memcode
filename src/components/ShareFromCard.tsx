import { Check, LoaderCircle, Send } from "lucide-react";
import type { Artifact } from "../shared";

/**
 * On the computer that ran a card's worker: the card's files. Documents and images go
 * to everyone on the shared project by themselves when the run finishes; any other
 * file when the person shares it.
 */
export function ShareFromCard({
  projectName,
  artifacts,
  sharedNames,
  busy,
  onShare,
}: {
  projectName: string;
  artifacts: Artifact[];
  /** Names of files already shared from this computer. */
  sharedNames: Set<string>;
  /** The id of the file being shared, if one is. */
  busy: string;
  onShare(artifact: Artifact): void;
}) {
  if (!artifacts.length) return null;
  return (
    <section className="share-from-card" aria-label="Share with the project">
      <div className="eyebrow">
        <span />
        SHARE WITH THE PROJECT
      </div>
      <p>
        Documents and images the worker makes are shared with everyone on{" "}
        <strong>{projectName}</strong> when its run finishes. Share any other
        file yourself.
      </p>
      <ul>
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <span>{artifact.name}</span>
            {sharedNames.has(artifact.name) ? (
              <small className="share-from-card-done">
                <Check size={12} />
                Shared
              </small>
            ) : (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => onShare(artifact)}
              >
                {busy === artifact.id ? (
                  <LoaderCircle className="spin" size={12} />
                ) : (
                  <Send size={12} />
                )}
                Share
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
