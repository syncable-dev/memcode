import { z } from "zod";
import { changeKinds, verdictKinds } from "../src/fleet";

/**
 * What a worker can say to Fleet. Declare before a group of edits, record right after it,
 * give a verdict when two edits truly disagree, and sync to hear what peers did.
 */
export const coordinationSchema = z
  .object({
    action: z.enum(["declare", "record", "verdict", "sync"]),
    symbols: z.array(z.string().trim().min(1).max(400)).min(1).max(40).optional(),
    kind: z.enum(changeKinds).optional(),
    plan: z.string().trim().min(1).max(1600).optional(),
    decisionId: z.string().trim().min(1).max(200).optional(),
    verdict: z.enum(verdictKinds).optional(),
    winner: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().min(1).max(1600).optional(),
    waitMs: z.number().int().min(0).max(20000).default(0),
  })
  .strict();
export type CoordinationRequest = z.infer<typeof coordinationSchema>;
