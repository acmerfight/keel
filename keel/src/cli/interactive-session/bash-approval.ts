import {
  type BashApprovalGrant,
  type BashMode,
  createSessionBashPermissionPolicy,
  type SessionBashPermissionPolicy,
} from "../../permissions/bash.ts";
import type { LineReader } from "./line-reader.ts";

export function escapeApprovalText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: approval prompts must render model-controlled bytes visibly.
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (char) => {
      switch (char) {
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "\t":
          return "\\t";
        default: {
          const code = char.charCodeAt(0);
          return code <= 0x9f
            ? `\\x${code.toString(16).padStart(2, "0")}`
            : `\\u{${code.toString(16)}}`;
        }
      }
    },
  );
}

export function interactiveBashPermissionPolicy(
  mode: BashMode,
  lineReader: LineReader,
  writeStderr: (text: string) => void,
  policyOptions: {
    readonly initialGrants?: readonly BashApprovalGrant[];
    readonly onGrant?: (grant: BashApprovalGrant) => void;
  },
): SessionBashPermissionPolicy | undefined {
  if (mode !== "ask") {
    return undefined;
  }

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
  },
): SessionBashPermissionPolicy {
  return createSessionBashPermissionPolicy({
    ...(policyOptions.initialGrants !== undefined
      ? { initialGrants: policyOptions.initialGrants }
      : {}),
    ...(policyOptions.onGrant !== undefined
      ? { onGrant: policyOptions.onGrant }
      : {}),
    prompt: async (request) => {
      const promptSequence = lineReader.sequence();
      const prefixApprovalLine =
        request.prefixApproval === undefined
          ? []
          : [
              `[p] allow ${request.prefixApproval.promptLabel} for ${policyOptions.scopeLabel}: ${escapeApprovalText(
                request.prefixApproval.display,
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
        return { type: "allow", scope: "session-prefix" };
      }
      return { type: "deny", message: "User did not approve this command." };
    },
  });
}
