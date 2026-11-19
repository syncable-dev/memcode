import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  LogOut,
  RefreshCw,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import type { MemCodeBetaStatus } from "../beta";
import type { MemtraceAccount } from "../connections";
import { AccountConnections } from "./AccountConnections";
import { Spinner } from "./UI";
import "../styles-beta.css";

export function BetaAccess({
  notify,
  compact = false,
  existingCLI = false,
  onStatus,
  onAccountStatus,
  welcome = false,
}: {
  notify: (message: string) => void;
  compact?: boolean;
  existingCLI?: boolean;
  onStatus?: (status: MemCodeBetaStatus) => void;
  onAccountStatus?: (account: MemtraceAccount) => void;
  welcome?: boolean;
}) {
  const [status, setStatus] = useState<MemCodeBetaStatus>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<"sign-out" | "cli">();
  const callback = useRef(onStatus);
  const request = useRef(0);
  callback.current = onStatus;
  useEffect(() => {
    if (!open) return;
    if (typeof window.memcode.betaStatus !== "function") {
      setError("Reopen the updated MemCode app to connect beta access.");
      return;
    }
    let live = true;
    const update = (value: MemCodeBetaStatus) => {
      if (!live) return;
      setStatus(value);
      callback.current?.(value);
    };
    const unsubscribe = window.memcode.onBetaStatus?.(update);
    void window.memcode
      .betaStatus?.()
      .then(update)
      .catch(() => {
        if (live)
          setError("Reopen the updated MemCode app to connect beta access.");
      });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [open]);
  useEffect(() => {
    if (!compact || !open) return;
    window.dispatchEvent(new CustomEvent("memcode:popover", { detail: true }));
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      window.dispatchEvent(
        new CustomEvent("memcode:popover", { detail: false }),
      );
    };
  }, [compact, open]);
  const act = async (
    action: "connect" | "cancel" | "refresh" | "sign-out" | "cli",
  ) => {
    const id = ++request.current;
    setBusy(true);
    setError("");
    setConfirmation(undefined);
    try {
      const next = await (action === "connect"
        ? window.memcode.connectBeta()
        : action === "cancel"
          ? window.memcode.cancelBeta()
          : action === "refresh"
            ? window.memcode.refreshBeta()
            : action === "cli"
              ? window.memcode.useExistingMemtraceCLI()
              : window.memcode.signOutBeta());
      if (id === request.current) {
        setStatus(next);
        callback.current?.(next);
      }
    } catch (reason) {
      if (id === request.current) {
        const message =
          reason instanceof Error
            ? reason.message
            : "Beta access could not finish. Try again.";
        setError(message);
        notify(message);
      }
    } finally {
      if (id === request.current) setBusy(false);
    }
  };
  const pending = status?.loginPending || busy;
  const connected = status?.state === "connected";
  const panel = (
    <section className="beta-access" aria-label="Memtrace beta access">
      <header>
        <span className="beta-access-icon">
          <ShieldCheck size={17} />
        </span>
        <div>
          <strong>
            {connected
              ? (status.account?.name ?? "Memtrace connected")
              : welcome
                ? "Your Memtrace account"
                : "Connect Memtrace beta"}
          </strong>
          <small>
            {connected && status.account?.email
              ? status.account.email
              : welcome
                ? "One account for MemCode and Memtrace."
                : "Your account. Your local code engine."}
          </small>
        </div>
        <span className={"beta-access-state " + (connected ? "connected" : "")}>
          {connected ? (
            <>
              <Check size={12} /> Connected
            </>
          ) : welcome ? (
            "In your browser"
          ) : (
            "Noncommercial beta"
          )}
        </span>
        {compact && (
          <button
            type="button"
            className="icon-button"
            onClick={() => setOpen(false)}
            aria-label="Close account"
          >
            <X size={14} />
          </button>
        )}
      </header>
      <p>
        {welcome && !connected && !pending
          ? "Continue in your browser to sign in or create a free account. Approve MemCode, then return here; we’ll connect automatically."
          : (status?.detail ??
            "Approve access with your Memtrace account. MemCode prepares the local engine for you.")}
      </p>
      {!welcome && !connected && !pending && (
        <p className="beta-access-note">
          Unlimited local Memtrace analysis during the noncommercial beta.
          Coding models use your own accounts and credits.
        </p>
      )}
      {error && (
        <p className="beta-access-error" role="alert">
          {error}
        </p>
      )}
      {confirmation ? (
        <div className="beta-access-confirm">
          <p>
            {confirmation === "cli"
              ? "Use the separately installed Memtrace CLI and its account, plan and usage limits? Beta access will be disconnected. Running workers must finish first."
              : "Sign out of beta on this device? Local work stays saved. The engine remains paused until you reconnect or explicitly choose your installed CLI."}
          </p>
          <div>
            <button
              type="button"
              className="button secondary"
              onClick={() => setConfirmation(undefined)}
            >
              Keep connection
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => void act(confirmation)}
            >
              {confirmation === "cli" ? "Use existing CLI" : "Sign out"}
            </button>
          </div>
        </div>
      ) : (
        <div className="beta-access-actions">
          {pending ? (
            <>
              <span className="beta-access-pending">
                <Spinner />{" "}
                {status?.canCancel === false
                  ? "Preparing local engine…"
                  : "Waiting for browser approval…"}
              </span>
              {status?.canCancel !== false && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void act("cancel")}
                >
                  Cancel
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className="button primary"
                disabled={!status}
                onClick={() => void act("connect")}
              >
                {connected
                  ? "Change account"
                  : welcome
                    ? "Sign in or create account"
                    : "Connect Memtrace beta"}
                <ArrowUpRight size={13} />
              </button>
              {status?.accessMode === "beta" && (
                <>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void act("refresh")}
                    title="Refresh beta connection"
                  >
                    <RefreshCw size={13} />
                    Refresh
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Sign out of Memtrace beta"
                    onClick={() => setConfirmation("sign-out")}
                  >
                    <LogOut size={14} />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {(existingCLI || status?.accessMode === "beta") && (
        <details className="beta-cli-details">
          <summary>Existing Memtrace CLI setup</summary>
          <p>
            For an existing installation, use its separate sign-in and plan.
            MemCode never switches to paid CLI usage automatically.
          </p>
          {status?.accessMode === "beta" ? (
            <button
              type="button"
              className="button secondary"
              disabled={!!pending}
              onClick={() => setConfirmation("cli")}
            >
              Use existing CLI setup
            </button>
          ) : (
            <AccountConnections notify={notify} onStatus={onAccountStatus} />
          )}
        </details>
      )}
    </section>
  );
  if (!compact) return panel;
  return (
    <div className="beta-account-menu">
      <button
        type="button"
        className="account-trigger"
        aria-label="Memtrace account"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <UserRound size={15} />
      </button>
      {open && (
        <>
          <button
            type="button"
            className="beta-account-dismiss"
            aria-label="Close account menu"
            onClick={() => setOpen(false)}
          />
          <div className="beta-account-popover">{panel}</div>
        </>
      )}
    </div>
  );
}
