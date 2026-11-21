/** Bounded source coverage for a routing decision. Counts describe observed evidence. */
export interface RoutingScopeCoverage {
  confirmedTargets: number;
  inferredTargets: number;
  unresolvedReferences: number;
  measuredTargets: number;
  incomplete: boolean;
  publicContracts?: number;
  nearbyTests?: number;
}

/** Unique upstream dependencies observed across the selected source anchors. */
export interface RoutingImpactEvidence {
  targetCount: number;
  observedTargets: number;
  basis: "confirmed" | "inferred";
  incomplete: boolean;
  affectedSymbols?: number;
  affectedFiles?: number;
  affectedProcesses?: number;
  affectedModules?: number;
}
