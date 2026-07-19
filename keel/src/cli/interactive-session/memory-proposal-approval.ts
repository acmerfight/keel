import type {
  AgentMemoryProposalReviewDecision,
  AgentMemoryProposalReviewRequest,
} from "../../tools/memory.ts";
import { escapeApprovalText } from "../bash-approval-text.ts";
import type { LineReader } from "./line-reader.ts";

export function createInteractiveMemoryProposalReview(
  lineReader: LineReader,
  writeStderr: (text: string) => void,
  lifecycle: {
    readonly onPromptStart: () => void;
    readonly onPromptEnd: () => void;
  },
): (
  request: AgentMemoryProposalReviewRequest,
  signal: AbortSignal,
) => Promise<AgentMemoryProposalReviewDecision> {
  return async (request, signal) => {
    lifecycle.onPromptStart();
    try {
      const promptSequence = lineReader.sequence();
      writeStderr(
        [
          "Approve project memory?",
          `candidate: ${escapeApprovalText(request.candidateId)}`,
          `scope: ${escapeApprovalText(request.scope.id)}`,
          `kind: ${request.kind}`,
          `statement: ${escapeApprovalText(request.statement)}`,
          `source: "${escapeApprovalText(request.sourceQuote)}"`,
          `why: ${escapeApprovalText(request.why)}`,
          `conflicts: ${
            request.conflictMemoryIds.length === 0
              ? "none"
              : request.conflictMemoryIds
                  .map((id) => escapeApprovalText(id))
                  .join(", ")
          }`,
          "[y] approve, [n] reject; any other input rejects: ",
        ].join("\n"),
      );
      const rawAnswer = await lineReader.readLineAfter(promptSequence, signal);
      if (rawAnswer === null) return { type: "pending" };
      const answer = rawAnswer.trim().toLowerCase();
      return answer === "y" || answer === "yes"
        ? { type: "approve" }
        : { type: "reject" };
    } finally {
      lifecycle.onPromptEnd();
    }
  };
}
