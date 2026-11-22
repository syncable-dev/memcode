import { Check, LoaderCircle, Send } from "lucide-react";
import type { Artifact } from "../shared";

/**
 * On the computer that ran a card's worker: the card's files, each shared with
 * everyone on the shared project only when the person says so.
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
        Files stay on this computer until you share them. Everyone on{" "}
        <strong>{projectName}</strong> can then open them from this card.
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
