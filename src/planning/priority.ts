/** How urgent a task is, most urgent first. */
export const priorities = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof priorities)[number];

export const priorityLabels: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
  none: "No priority",
};

/**
 * MemCodes from before Urgent and No priority know three. On a shared board the priority
 * is the nearest of those, and what it really is stands beside it.
 */
export const plainPriority = (priority: Priority): "high" | "medium" | "low" =>
  priority === "urgent" ? "high" : priority === "none" ? "low" : priority;
