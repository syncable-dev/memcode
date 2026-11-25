import { useEffect } from "react";

const LOOK_AGAIN_MS = 5_000;

/** People merge on GitHub and come back to MemCode: that is when it looks. */
export function NoticeMerges({ projectId }: { projectId: string }) {
  useEffect(() => {
    let lookedAt = 0;
    const look = () => {
      if (
        document.visibilityState === "hidden" ||
        Date.now() - lookedAt < LOOK_AGAIN_MS
      )
        return;
      lookedAt = Date.now();
      void window.memcode?.noticeMerges?.(projectId).catch(() => {});
    };
    look();
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => {
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [projectId]);
  return null;
}
