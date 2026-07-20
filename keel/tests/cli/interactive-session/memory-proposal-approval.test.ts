import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createLineReader } from "../../../src/cli/interactive-session/line-reader.ts";
import { createInteractiveMemoryProposalReview } from "../../../src/cli/interactive-session/memory-proposal-approval.ts";

const request = {
  candidateId: "cand_review",
  scope: { kind: "project" as const, id: "project_review" },
  kind: "project_context" as const,
  statement: "Release validation uses pnpm test:coverage.",
  why: "Likely to help in another session.",
  sourceQuote: "pnpm test:coverage",
  conflictMemoryIds: [],
};

describe("interactive memory proposal approval", () => {
  test(`Given a reviewed-memory prompt displays the governed candidate,
    When the user answers yes after the prompt starts,
    Then the adapter approves and restores steering mode`, async () => {
    const input = new PassThrough();
    const promptInput = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const modes: string[] = [];
    let stderr = "";
    const review = createInteractiveMemoryProposalReview(
      createLineReader(promptInput, {}),
      (text) => {
        stderr += text;
        input.end("y\n");
      },
      {
        onPromptStart: () => modes.push("approval"),
        onPromptEnd: () => modes.push("steer"),
      },
    );

    const decision = await review(request, new AbortController().signal);

    expect(decision).toEqual({ type: "approve" });
    expect(stderr).toContain("Approve project memory?");
    expect(stderr).toContain(`candidate: ${request.candidateId}`);
    expect(stderr).toContain(`statement: ${request.statement}`);
    expect(stderr).toContain(`source: "${request.sourceQuote}"`);
    expect(modes).toEqual(["approval", "steer"]);
    promptInput.close();
  });

  test(`Given reviewed-memory approval input closes or is interrupted,
    When no post-prompt answer can be read,
    Then the adapter leaves the already-recorded candidate pending`, async () => {
    const input = new PassThrough();
    const promptInput = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const review = createInteractiveMemoryProposalReview(
      createLineReader(promptInput, {}),
      () => input.end(),
      {
        onPromptStart: () => {},
        onPromptEnd: () => {},
      },
    );

    expect(
      await review(
        {
          ...request,
          conflictMemoryIds: ["mem_existing", "mem_other"],
        },
        new AbortController().signal,
      ),
    ).toEqual({ type: "pending" });
    promptInput.close();
  });
});
