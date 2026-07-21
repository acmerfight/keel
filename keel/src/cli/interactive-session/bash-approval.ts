import {
  type BashApprovalGrant,
  type BashProjectApprovalGrant,
  createSessionBashPermissionPolicy,
  type SessionBashPermissionPolicy,
} from "../../permissions/bash.ts";
import { escapeApprovalText } from "../bash-approval-text.ts";
import type { LineReader } from "./line-reader.ts";

export function interactiveBashPermissionPolicy(
  lineReader: LineReader,
  writeStderr: (text: string) => void,
  policyOptions: {
    readonly initialGrants?: readonly BashApprovalGrant[];
    readonly onGrant?: (grant: BashApprovalGrant) => void;
    readonly projectRoot?: string;
    readonly initialProjectGrants?: readonly BashProjectApprovalGrant[];
    readonly onProjectGrant?: (grant: BashProjectApprovalGrant) => void;
    readonly onPromptStart?: () => void;
    readonly onPromptEnd?: () => void;
  },
): SessionBashPermissionPolicy {
  return createPromptedBashPermissionPolicy(lineReader, writeStderr, {
    ...policyOptions,
    scopeLabel: "session",
  });
}

export function createPromptedBashPermissionPolicy(
  lineReader: LineReader,
  writeStderr: (text: string) => void,
  policyOptions: {
    readonly scopeLabel: "session" | "this run";
    readonly initialGrants?: readonly BashApprovalGrant[];
    readonly onGrant?: (grant: BashApprovalGrant) => void;
    readonly projectRoot?: string;
    readonly initialProjectGrants?: readonly BashProjectApprovalGrant[];
    readonly onProjectGrant?: (grant: BashProjectApprovalGrant) => void;
    readonly onPromptStart?: () => void;
    readonly onPromptEnd?: () => void;
  },
): SessionBashPermissionPolicy {
  return createSessionBashPermissionPolicy({
    ...(policyOptions.initialGrants !== undefined
      ? { initialGrants: policyOptions.initialGrants }
      : {}),
    ...(policyOptions.onGrant !== undefined
      ? { onGrant: policyOptions.onGrant }
      : {}),
    ...(policyOptions.projectRoot !== undefined
      ? { projectRoot: policyOptions.projectRoot }
      : {}),
    initialProjectGrants: policyOptions.initialProjectGrants ?? [],
    onProjectGrant:
      policyOptions.onProjectGrant ??
      ((_grant: BashProjectApprovalGrant) => undefined),
    prompt: async (request) => {
      policyOptions.onPromptStart?.();
      try {
        const promptSequence = lineReader.sequence();
        const prefixApprovalLine =
          request.prefixApproval === undefined
            ? []
            : [
                `[p] allow ${request.prefixApproval.promptLabel} for ${policyOptions.scopeLabel}: ${escapeApprovalText(
                  request.prefixApproval.display,
                )}`,
              ];
        const projectApprovalLine =
          request.projectApproval === undefined
            ? []
            : [
                `[r] allow ${request.projectApproval.promptLabel} for this project: ${escapeApprovalText(
                  request.projectApproval.display,
                )}`,
              ];
        writeStderr(
          [
            "Approve bash command?",
            `cwd: ${escapeApprovalText(request.cwd)}`,
            `$ ${escapeApprovalText(request.command)}`,
            `risk: ${request.assessment.risk} - ${escapeApprovalText(
              request.assessment.summary,
            )}`,
            ...prefixApprovalLine,
            ...projectApprovalLine,
            "Approved command output may be sent to the provider unredacted.",
            `[y] allow once, [s] allow exact command for ${policyOptions.scopeLabel}, [n] deny; any other input denies: `,
          ].join("\n"),
        );
        const rawAnswer = await lineReader.readLineAfter(
          promptSequence,
          request.signal,
        );
        if (rawAnswer === null) {
          return {
            type: "deny",
            message: "Command approval was interrupted or input closed.",
          };
        }
        const answer = rawAnswer.trim().toLowerCase();
        if (answer === "") {
          return {
            type: "deny",
            message: "No approval response provided.",
          };
        }
        if (answer === "y" || answer === "yes") {
          return { type: "allow", scope: "once" };
        }
        if (answer === "s" || answer === "session" || answer === "a") {
          return { type: "allow", scope: "session" };
        }
        if (request.prefixApproval !== undefined && answer === "p") {
          return request.prefixApproval;
        }
        if (request.projectApproval !== undefined && answer === "r") {
          return request.projectApproval;
        }
        return { type: "deny", message: "User did not approve this command." };
      } finally {
        policyOptions.onPromptEnd?.();
      }
    },
  });
}
