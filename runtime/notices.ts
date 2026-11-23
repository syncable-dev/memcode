import { randomUUID } from "node:crypto";
import type { AppState } from "../src/shared";
import { now } from "./local";

const NOTICES_KEPT = 5;

/** Leaves a short message for the person, shown once in the window. The newest five are kept. */
export function tellPerson(state: AppState, text: string, at: string = now()): void {
  state.notices = [...(state.notices ?? []), { id: randomUUID(), text, at }].slice(-NOTICES_KEPT);
}
