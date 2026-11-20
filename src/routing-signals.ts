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
  /** Local classification evidence. Prompt text and feature values stay out of the route. */
  language?: {
    digest: string;
    outcome: "classified" | "abstained";
    scores: { kind: Exclude<RoutingRequestKind, "unknown">; score: number }[];
  };
}
