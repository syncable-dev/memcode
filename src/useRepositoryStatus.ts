import { useEffect, useState } from "react";
import type { RepositoryStatus } from "./branches";
import type { Project } from "./shared";

/**
 * The repository behind a local project folder, loaded again when the project or
 * its chosen base branch changes. Example projects and projects without a folder
 * have none.
 */
export function useRepositoryStatus(
  project: Project | undefined,
): RepositoryStatus | undefined {
  const [loaded, setLoaded] = useState<{
    projectId: string;
    status: RepositoryStatus;
  }>();
  const projectId = project?.id;
  const hasFolder = !!project?.path && !project.example;
  const baseBranch = project?.baseBranch;
  useEffect(() => {
    if (!projectId || !hasFolder) return;
    let live = true;
    void window.memcode
      .repositoryStatus(projectId)
      .then((status) => {
        if (live) setLoaded({ projectId, status });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, hasFolder, baseBranch]);
  if (!hasFolder || !loaded || loaded.projectId !== projectId) return undefined;
  return loaded.status;
}
