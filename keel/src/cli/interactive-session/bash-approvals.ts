import {
  type BashApprovalGrant,
  bashCommandFamilyDisplay,
} from "../../permissions/bash.ts";
import { escapeApprovalText } from "../bash-approval-text.ts";

export function formatBashApprovalList(
  grants: readonly BashApprovalGrant[],
): string {
  if (grants.length === 0) {
    return "No bash approvals for this session.\n";
  }

  const approvalLines: string[] = [];
  for (const [index, grant] of grants.entries()) {
    switch (grant.type) {
      case "exact":
        approvalLines.push(
          `  ${index + 1}. exact command`,
          `     cwd: ${escapeApprovalText(grant.cwd)}`,
          `     command: ${escapeApprovalText(grant.command)}`,
        );
        break;
      case "prefix":
        approvalLines.push(
          `  ${index + 1}. command family`,
          `     cwd: ${escapeApprovalText(grant.cwd)}`,
          `     argv prefix: ${escapeApprovalText(grant.argvPrefix.join(" "))}`,
        );
        break;
      case "command_family":
        approvalLines.push(
          `  ${index + 1}. command family`,
          `     cwd: ${escapeApprovalText(grant.cwd)}`,
          `     family: ${escapeApprovalText(
            bashCommandFamilyDisplay(grant.commandFamily),
          )}`,
        );
        break;
    }
  }

  return [
    "Bash approvals:",
    ...approvalLines,
    "Use /approvals revoke <index> or /approvals clear to remove approvals.",
    "",
  ].join("\n");
}

export function formatBashApprovalRevoked(index: number): string {
  return `Revoked bash approval ${index}.\n`;
}

export function formatBashApprovalClearResult(count: number): string {
  if (count === 0) {
    return "No bash approvals to clear.\n";
  }

  return count === 1
    ? "Cleared 1 bash approval.\n"
    : `Cleared ${count} bash approvals.\n`;
}
