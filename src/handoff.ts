/** Whether PR and commit text names MemCode. "ask" until the person chooses. */
export type HandoffAttribution = "ask" | "include" | "omit";

export interface HandoffText {
  title: string;
  pullRequest: string;
  commitMessage: string;
}
