import type { ReactNode } from "react";

/** The pieces every guide illustration is drawn with. */
export function Row({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`guide-preview-row ${className}`}>{children}</div>;
}
export function Label({ children }: { children: ReactNode }) {
  return <span className="guide-preview-label">{children}</span>;
}
export function Action({
  children,
  quiet = false,
}: {
  children: ReactNode;
  quiet?: boolean;
}) {
  return (
    <span className={`guide-preview-action ${quiet ? "quiet" : ""}`}>
      {children}
    </span>
  );
}
