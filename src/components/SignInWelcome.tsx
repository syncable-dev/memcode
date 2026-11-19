import type { MemCodeBetaStatus } from "../beta";
import type { MemtraceAccount } from "../connections";
import { Modal } from "./Dialogs";
import { BetaAccess } from "./BetaAccess";
import { Mark } from "./UI";

export function SignInWelcome({
  onSkip,
  notify,
  onStatus,
  onAccountStatus,
}: {
  onSkip: () => void;
  notify: (message: string) => void;
  onStatus: (status: MemCodeBetaStatus) => void;
  onAccountStatus: (account: MemtraceAccount) => void;
}) {
  return (
    <Modal
      title="Welcome to your next build."
      kicker="SIGN IN TO MEMCODE"
      description="Connect once. Keep your projects, settings and local tools across updates."
      close={onSkip}
    >
      <div className="modal-body sign-in-welcome">
        <div className="sign-in-welcome-brand">
          <Mark />
          <span>
            Your code stays on this computer.
            <small>Team sharing is always your choice.</small>
          </span>
        </div>
        <BetaAccess
          welcome
          existingCLI
          notify={notify}
          onStatus={onStatus}
          onAccountStatus={onAccountStatus}
        />
        <p>
          No Memtrace account yet? Create one in the same browser flow. Local
          Memtrace analysis is unlimited during the noncommercial beta. Coding
          workers use your own provider accounts.
        </p>
        <button type="button" className="text-button" onClick={onSkip}>
          Explore without signing in for now
        </button>
        <small>
          We’ll remind you next time you open MemCode. Connect before running
          workers or code analysis.
        </small>
      </div>
    </Modal>
  );
}
