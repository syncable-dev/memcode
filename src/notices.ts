/** A short message from MemCode itself, shown once in the window. */
export interface Notice {
  id: string;
  text: string;
  at: string;
}

/** The notices the window has not shown yet, oldest first. */
export function unseenNotices(notices: Notice[] | undefined, seen: ReadonlySet<string>): Notice[] {
  return (notices ?? []).filter((notice) => !seen.has(notice.id));
}

const SHOWN_NOTICES = "memcode.shownNotices";

/** Notices this window has already shown, kept across reloads where storage allows. */
export function readShownNotices(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SHOWN_NOTICES) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function rememberShownNotices(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(SHOWN_NOTICES, JSON.stringify([...ids].slice(-20)));
  } catch {
    // Storage can be unavailable; a notice may then show again after a reload.
  }
}
