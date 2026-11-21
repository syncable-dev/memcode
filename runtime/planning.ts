import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AppState, Project } from "../src/shared";

type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
export function registerPlanning(
  register: Register,
  state: () => AppState,
  project: (id: string) => Project,
  changed: () => Promise<void>,
): void {
  const id = z.string().min(1).max(200),
    title = z.string().trim().min(1).max(160),
    phase = z.enum(["now", "next", "later"]);
  register(
    "epic:create",
    z.object({
      projectId: id,
      title,
      description: z.string().max(10000),
      phase,
    }),
    async (input) => {
      project(input.projectId);
      const existing = state().epics.filter(
        (e) => e.projectId === input.projectId,
      );
      const epic = {
        ...input,
        id: randomUUID(),
        identifier: `EP-${String(existing.length + 1).padStart(2, "0")}`,
        color: "mint" as const,
        order: existing.length,
      };
      state().epics.push(epic);
      await changed();
      return epic;
    },
  );
  register(
    "epic:update",
    z.object({
      id,
      patch: z
        .object({
          title: title.optional(),
          description: z.string().max(10000).optional(),
          phase: phase.optional(),
        })
        .strict(),
    }),
    async ({ id, patch }) => {
      const epic = state().epics.find((e) => e.id === id);
      if (!epic) throw new Error("Goal not found.");
      Object.assign(epic, patch);
      await changed();
    },
  );
}
