import { useMemo } from "react";
import type { InboxFile } from "../inbox";
import { FileTiles, type FileSource } from "./FileTiles";

const notKeptNames = {
  too_big: "Too big to copy. Open it in Slack.",
  no_room: "The project's files are full. Open it in Slack.",
  unreadable: "Slack did not hand it over. Open it in Slack.",
} as const;

/** The files a report brought. A click shows or opens one. */
export function InboxEvidence({
  files,
  projectId,
  notify,
}: {
  files: InboxFile[];
  projectId: string;
  notify: (message: string) => void;
}) {
  const source = useMemo<FileSource<InboxFile>>(() => {
    const kept = (file: InboxFile) => ({
      projectId,
      sha256: file.sha256!,
      name: file.name,
    });
    return {
      key: `inbox:${projectId}`,
      bytes: ({ sha256 }) =>
        window.memcode.inboxFile({ projectId, sha256: sha256! }),
      thumbnail: (file) => window.memcode.inboxThumbnail(kept(file)),
      show: (file, bounds) =>
        window.memcode.showInboxFile({ ...kept(file), bounds }),
      open: (file) => window.memcode.openInboxFile(kept(file)),
      elsewhere: {
        label: "Open in Slack",
        open: (file) =>
          window.memcode.openInboxLink({ projectId, url: file.slackUrl }),
      },
    };
  }, [projectId]);
  return (
    <FileTiles
      files={files}
      source={source}
      notify={notify}
      about={(file) =>
        file.notKept && <small>{notKeptNames[file.notKept]}</small>
      }
    />
  );
}
