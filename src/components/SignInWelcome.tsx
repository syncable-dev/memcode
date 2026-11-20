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
      description="Your Memtrace account works here too. New here? Create one as you sign in."
      close={onSkip}
    >
      <div className="modal-body sign-in-welcome">
        <div className="sign-in-welcome-brand">
          <Mark />
          <span>
            Your work, in focus.
            <small>Your code and workers stay on this computer.</small>
          </span>
        </div>
        <BetaAccess
          welcome
          notify={notify}
          onStatus={onStatus}
          onAccountStatus={onAccountStatus}
        />
        <p>
          Noncommercial beta · Unlimited local Memtrace analysis. Your
          coding-model accounts stay separate.
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
