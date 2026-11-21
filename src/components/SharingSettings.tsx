import { Share2 } from "lucide-react";
import type { SharingSettings as Addresses } from "../sharing";

const tokenAddressExample = "https://www.memtrace.io/api/memcode/memsync/token";

/** The two addresses sharing needs. Both empty keeps sharing out of the app. */
export function SharingSettings({
  value,
  change,
}: {
  value: Addresses | undefined;
  change: (value: Addresses) => void;
}) {
  const addresses = value ?? { memsyncUrl: "", tokenUrl: "" };
  return (
    <details className="settings-engine-advanced">
      <summary>Advanced · sharing service</summary>
      <div className="settings-section">
        <div>
          <Share2 size={17} />
          <span>
            <strong>Sharing service</strong>
            <small>
              Where your shared projects live. Sharing appears in the sidebar
              once both addresses are set.
            </small>
          </span>
        </div>
        <div className="settings-sharing-fields">
          <label className="field">
            <span>Sharing service address</span>
            <input
              aria-label="Sharing service address"
              placeholder="https://"
              value={addresses.memsyncUrl}
              onChange={(event) =>
                change({ ...addresses, memsyncUrl: event.target.value })
              }
            />
          </label>
          <label className="field">
            <span>Sign-in address for sharing</span>
            <input
              aria-label="Sign-in address for sharing"
              placeholder={tokenAddressExample}
              value={addresses.tokenUrl}
              onChange={(event) =>
                change({ ...addresses, tokenUrl: event.target.value })
              }
            />
          </label>
          <p>
            MemCode shows your Memtrace sign-in to the sign-in address, so it
            must be at www.memtrace.io or on this computer.
          </p>
        </div>
      </div>
    </details>
  );
}
