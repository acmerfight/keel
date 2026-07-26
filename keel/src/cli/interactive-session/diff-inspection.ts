import { executeGitDiff } from "../../tools/git-diff.ts";
import {
  type GitDiffDocument,
  parseGitDiffOutput,
} from "../../tools/git-diff-document.ts";
import { executeGitStatus } from "../../tools/git-status.ts";
import { formatInteractiveCommandFailure } from "./commands.ts";

const NON_GIT_DIFF_MESSAGE =
  "Not in a git work tree. /diff can only inspect changes inside a Git repository.";

export type InteractiveDiffInspection =
  | {
      readonly kind: "non-git";
      readonly message: string;
    }
  | {
      readonly kind: "clean";
      readonly statusOutput: string;
    }
  | {
      readonly kind: "changes";
      readonly statusOutput: string;
      readonly plainDiffOutput: string;
      readonly document: GitDiffDocument;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
    };

export function formatInteractiveDiffOutput(
  inspection: InteractiveDiffInspection,
): string {
  switch (inspection.kind) {
    case "non-git":
    case "failed":
      return `${inspection.message}\n`;
    case "clean":
      return `${inspection.statusOutput}\n`;
    case "changes":
      return `${inspection.statusOutput}\n\n${inspection.plainDiffOutput}\n`;
  }
}

export async function inspectInteractiveDiff(
  workspace: string,
  hiddenPaths: readonly string[],
): Promise<InteractiveDiffInspection> {
  const status = await executeGitStatus(workspace, { hiddenPaths });
  if (!status.inGitWorkTree) {
    return { kind: "non-git", message: NON_GIT_DIFF_MESSAGE };
  }
  const diff = await executeGitDiff(workspace, {
    mode: "all",
    hiddenPaths,
  });
  if (!diff.hasChanges) {
    return { kind: "clean", statusOutput: status.content };
  }
  const reviewSource =
    diff.artifact === undefined
      ? {
          content: diff.content,
          sourceTruncated: diff.sourceTruncated === true,
        }
      : diff.artifact;
  return {
    kind: "changes",
    statusOutput: status.content,
    plainDiffOutput: diff.content,
    document: parseGitDiffOutput(
      reviewSource.content,
      reviewSource.sourceTruncated,
    ),
  };
}

export function failedInteractiveDiff(
  error: unknown,
): InteractiveDiffInspection {
  return {
    kind: "failed",
    message: formatInteractiveCommandFailure(error).trimEnd(),
  };
}
