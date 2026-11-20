export type RoutingRequestKind =
  | "explain"
  | "research"
  | "test"
  | "fix"
  | "implement"
  | "refactor"
  | "rename"
  | "unknown";

/** Content-free request characteristics used by the routing policy. */
export interface RoutingRequestSignals {
  kinds: RoutingRequestKind[];
  readOnly: boolean;
  fileScopeOnly: boolean;
  preserveBehavior: boolean;
  publicContract: "change" | "preserve" | "unspecified";
}
