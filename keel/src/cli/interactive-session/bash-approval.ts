import {
  type BashPermissionPolicy,
  createBashPermissionPolicy,
} from "../../permissions/bash.ts";
import { escapeApprovalText } from "../bash-approval-text.ts";
import type { LineReader } from "./line-reader.ts";

export function createPromptedBashPermissionPolicy(
  lineReader: LineReader,
  writeStderr: (text: string) => void,
  options: {
    readonly onPromptStart?: () => void;
    readonly onPromptEnd?: () => void;
  } = {},
): BashPermissionPolicy {
  return createBashPermissionPolicy(async (request) => {
    options.onPromptStart?.();
    try {
      const promptSequence = lineReader.sequence();
      writeStderr(
        [
          "Approve bash command?",
          `cwd: ${escapeApprovalText(request.cwd)}`,
          `$ ${escapeApprovalText(request.command)}`,
          "Approved command output may be sent to the provider unredacted.",
          "[y] allow once, [n] deny; any other input denies: ",
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
      if (answer === "y" || answer === "yes") {
        return { type: "allow" };
      }
      return {
        type: "deny",
        message:
          answer === ""
            ? "No approval response provided."
            : "User did not approve this command.",
      };
    } finally {
      options.onPromptEnd?.();
    }
  });
}
