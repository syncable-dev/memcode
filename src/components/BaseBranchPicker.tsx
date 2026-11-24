import { GitBranch } from "lucide-react";
import type { Project } from "../shared";
import { baseReasonText, type RepositoryStatus } from "../branches";
import { Select } from "./Select";

/** The branch pickers' value for "MemCode decides", marked like every other automatic choice. */
export const WORKED_OUT = "auto";

/**
 * The branch new goals start from, beside the project's name in the top bar so
 * every view shows it. Opening it says why MemCode picked it, and lets the
 * person pin another branch instead.
 */
export function BaseBranchPicker({
  project,
  repository,
  notify,
}: {
  project: Project;
  repository: RepositoryStatus;
  notify: (message: string) => void;
}) {
  const { base } = repository;
  const choose = (value: string) =>
    void window.memcode
      .setBaseBranch(project.id, value === WORKED_OUT ? null : value)
      .catch((error: Error) => notify(error.message));
  return (
    <span className="base-branch" title={`New goals branch from ${base.branch}. ${baseReasonText(base)}`}>
      <GitBranch size={12} aria-hidden="true" />
      <Select
        aria-label="Where new goals branch from"
        className="base-branch-picker"
        align="start"
        value={base.chosen ? base.branch : WORKED_OUT}
        onValueChange={choose}
      >
        <optgroup label="MemCode decides">
          <option
            value={WORKED_OUT}
            data-detail={
              base.chosen
                ? "From your merged pull requests and branches."
                : baseReasonText(base)
            }
          >
            {base.chosen ? "Work it out for me" : base.branch}
          </option>
        </optgroup>
        <optgroup label="Or always use">
          {repository.branches
            .filter((branch) => base.chosen || branch !== base.branch)
            .map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
        </optgroup>
      </Select>
    </span>
  );
}
