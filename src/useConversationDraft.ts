import { useCallback, useState, type SetStateAction } from "react";
import type { Attachment } from "./attachments";
import {
  ConversationDrafts,
  type ConversationDraft,
} from "./conversation-drafts";

const noFiles: Attachment[] = [];
const drafts = new ConversationDrafts(() =>
  typeof window === "undefined" ? undefined : window.sessionStorage,
);

/** Read on each card render so both keyed remounts and in-place switches work. */
export function useConversationDraft(taskId: string) {
  const [, refresh] = useState(0);
  const current = drafts.read(taskId);
  const setDraft = useCallback(
    (value: SetStateAction<string>) => {
      const previous = drafts.read(taskId);
      const draft = typeof value === "function" ? value(previous.draft) : value;
      if (draft === previous.draft) return;
      drafts.write(taskId, { ...previous, draft });
      refresh((version) => version + 1);
    },
    [taskId],
  );
  const setAttachedComments = useCallback(
    (value: SetStateAction<string[]>) => {
      const previous = drafts.read(taskId);
      const comments =
        typeof value === "function" ? value(previous.comments) : value;
      if (
        comments.length === previous.comments.length &&
        comments.every((id, index) => id === previous.comments[index])
      )
        return;
      drafts.write(taskId, { ...previous, comments });
      refresh((version) => version + 1);
    },
    [taskId],
  );
  const setFiles = useCallback(
    (change: (files: Attachment[]) => Attachment[]) => {
      const previous = drafts.read(taskId);
      const files = change(previous.files ?? []);
      drafts.write(taskId, { ...previous, files });
      refresh((version) => version + 1);
    },
    [taskId],
  );
  const clearSubmitted = useCallback(
    (submitted: ConversationDraft) => {
      if (drafts.clearSubmitted(taskId, submitted))
        refresh((version) => version + 1);
    },
    [taskId],
  );
  return {
    ...current,
    attachedComments: current.comments,
    files: current.files ?? noFiles,
    setDraft,
    setAttachedComments,
    setFiles,
    clearSubmitted,
  };
}
