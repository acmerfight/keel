import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertionEvidenceResourceFreshness } from "../../src/agent/assertion-evidence-freshness.ts";
import { evaluateAssertionGoalCompletionWithProvider } from "../../src/agent/assertion-goal-evaluator.ts";
import {
  compactCurrentToolOutputs,
  compactStaleToolOutputs,
} from "../../src/agent/context-compaction.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";
import {
  collect,
  freshSignal,
  ZERO_USAGE,
} from "../../src/testing/context-compaction-fixtures.ts";
import { observeReadResource } from "../../src/tools/read-resource-observation.ts";

describe("Assertion Evidence Freshness", () => {
  test(`Given a historical read result has no Runtime observation,
    When assertion evidence is prepared for evaluation,
    Then the read is marked unverifiable instead of being treated as current`, () => {
    // Given
    const messages: readonly Message[] = [
      { role: "user", content: "Inspect missing.txt." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "read_1", tool: "read", path: "missing.txt" },
          { id: "goal_1", tool: "update_goal", status: "completed" },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_1",
        content: "Tool failed: read failed: file not found: missing.txt",
      },
      {
        role: "tool",
        toolCallId: "goal_1",
        content: "Completion proposed.",
      },
    ];

    // When
    const freshness = assertionEvidenceResourceFreshness({
      workspace: process.cwd(),
      messages,
    });

    // Then
    expect(freshness).toEqual([
      {
        toolCallId: "read_1",
        kind: "read_projection",
        status: "unverifiable",
        reason:
          "Runtime has no resource observation for this historical read result.",
      },
    ]);
  });

  test(`Given a read result proving a file's contents was compaction-truncated,
    When Keel prepares assertion evidence for the completion judge,
    Then the read is reported unverifiable instead of matching the current file`, async () => {
    // Given
    const workspace = realpathSync(
      mkdtempSync(join(tmpdir(), "keel-truncated-evidence-")),
    );
    try {
      const targetPath = join(workspace, "config.ts");
      const fillerLines = Array.from(
        { length: 400 },
        (_unused, index) => `export const filler${index} = ${index};`,
      );
      const fileContent = `${[...fillerLines, "// TODO: remove before release"].join("\n")}\n`;
      writeFileSync(targetPath, fileContent);

      const readMessages: readonly Message[] = [
        { role: "user", content: "Remove every TODO from config.ts." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read_1", tool: "read", path: "config.ts" }],
        },
        {
          role: "tool",
          toolCallId: "read_1",
          content: fileContent,
          resourceObservation: observeReadResource({
            workspace,
            targetPath,
            content: fileContent,
          }),
        },
        { role: "assistant", content: "config.ts inspected.", toolCalls: [] },
      ];

      // When
      const compacted = compactStaleToolOutputs(readMessages, 2000);
      const compactedRead = compacted.messages.find(
        (message) => message.role === "tool",
      );
      const freshness = assertionEvidenceResourceFreshness({
        workspace,
        messages: compacted.messages,
      });

      const evaluatorPrompts: string[] = [];
      const provider: LLMProvider = {
        id: "truncated-evidence-evaluator",
        async *stream(options) {
          const [message] = options.messages;
          evaluatorPrompts.push(message?.content ?? "");
          yield {
            type: "text",
            text: JSON.stringify({
              completed: false,
              reason: "The omitted region is not proven.",
            }),
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 0,
              cachedInputTokens: 0,
              uncachedInputTokens: 0,
              outputTokens: 0,
            },
          };
        },
      };
      await evaluateAssertionGoalCompletionWithProvider({
        provider,
        signal: new AbortController().signal,
        goal: {
          objective: "Remove every TODO from config.ts",
          completionCriterion: "config.ts contains no TODO comment.",
        },
        resourceFreshness: freshness,
        modelOperations: null,
        evidenceMessages: compacted.messages,
      });

      // Then
      expect(compactedRead?.content).not.toContain("TODO: remove before");
      expect(freshness).toEqual([
        {
          toolCallId: "read_1",
          kind: "read_projection",
          status: "unverifiable",
          reason:
            "Context compaction removed part of this read projection, so Runtime cannot confirm the surfaced evidence is still current.",
        },
      ]);
      expect(evaluatorPrompts[0]).toContain('"status": "unverifiable"');
      expect(evaluatorPrompts[0]).not.toContain('"status": "matches"');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read result was shrunk before the provider request instead of after it,
    When Keel prepares assertion evidence for the completion judge,
    Then that read is also reported unverifiable rather than current`, () => {
    // Given
    const workspace = realpathSync(
      mkdtempSync(join(tmpdir(), "keel-preflight-evidence-")),
    );
    try {
      const targetPath = join(workspace, "report.txt");
      const fileContent = `${Array.from(
        { length: 400 },
        (_unused, index) => `row ${index}`,
      ).join("\n")}\n`;
      writeFileSync(targetPath, fileContent);

      const messages: readonly Message[] = [
        { role: "user", content: "Summarize report.txt." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read_1", tool: "read", path: "report.txt" }],
        },
        {
          role: "tool",
          toolCallId: "read_1",
          content: fileContent,
          resourceObservation: observeReadResource({
            workspace,
            targetPath,
            content: fileContent,
          }),
        },
      ];

      // When
      const compacted = compactCurrentToolOutputs(messages, 500, {
        policy: { reason: "preflight" },
        settledMaxChars: 500,
      });
      const freshness = assertionEvidenceResourceFreshness({
        workspace,
        messages: compacted.messages,
      });

      // Then
      expect(compacted.stats.toolOutputsCompacted).toBe(1);
      expect(freshness).toEqual([
        {
          toolCallId: "read_1",
          kind: "read_projection",
          status: "unverifiable",
          reason:
            "Context compaction removed part of this read projection, so Runtime cannot confirm the surfaced evidence is still current.",
        },
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a live agent turn compacted a read out of the model's view,
    When the model then proposes assertion-goal completion,
    Then the completion judge is told that read is unverifiable instead of current`, async () => {
    // Given
    const workspace = realpathSync(
      mkdtempSync(join(tmpdir(), "keel-live-evidence-")),
    );
    try {
      const fileContent = `${Array.from(
        { length: 600 },
        (_unused, index) => `audit row ${index}`,
      ).join("\n")}\n`;
      writeFileSync(join(workspace, "audit.txt"), fileContent);

      const messages: Message[] = [
        { role: "user", content: "Audit audit.txt then complete the goal." },
      ];
      const evaluatorPrompts: string[] = [];
      let mainRequests = 0;
      const provider: LLMProvider = {
        id: "live-evidence-provider",
        async *stream(options) {
          const last = options.messages.at(-1);
          if (
            typeof last?.content === "string" &&
            last.content.includes("Evaluate whether the surfaced evidence")
          ) {
            evaluatorPrompts.push(last.content);
            yield {
              type: "text",
              text: JSON.stringify({
                completed: false,
                reason: "The read evidence is no longer verifiable.",
              }),
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          mainRequests += 1;
          if (mainRequests <= 2) {
            yield {
              type: "tool_call",
              id: `read_${mainRequests}`,
              tool: "read",
              path: "audit.txt",
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          if (mainRequests === 3) {
            yield {
              type: "tool_call",
              id: "goal_1",
              tool: "update_goal",
              status: "completed",
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          yield { type: "text", text: "Audit incomplete." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };

      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          contextCompaction: {
            contextWindowTokens: 700,
            reserveTokens: 0,
            keepRecentTokens: 1,
            toolOutputMaxChars: 128,
          },
          sessionGoal: {
            objective: "Audit the file",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            completion: {
              kind: "assertion",
              assertion: "The audit file contents were fully reviewed.",
            },
          },
        }),
      );

      // Then
      const prompt = evaluatorPrompts[0] ?? "";
      expect(prompt).not.toContain("audit row 599");
      expect(prompt).toContain('"status": "unverifiable"');
      expect(prompt).not.toContain('"status": "matches"');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
