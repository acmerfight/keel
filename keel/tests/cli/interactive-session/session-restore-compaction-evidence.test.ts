import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import {
  createSessionStore,
  persistSessionMessages,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import type { LLMProvider } from "../../../src/llm/types.ts";
import { CHECKPOINT_INSTRUCTION } from "../../../src/testing/context-compaction-fixtures.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  ForcedExit,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

describe("Interactive Session - Restored Compaction Evidence", () => {
  test(`Given a resumed session has decoy visible checkpoint evidence and trusted metadata,
    When user compacts and continues,
    Then the next agent response is based on restored metadata evidence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const realHandle = "tool-output:restore/real-report";
    const decoyHandle = "tool-output:restore/decoy-report";
    const evidence = [
      {
        handle: realHandle,
        label: "bash restored report",
        source: "complete",
        inspectCommand: `keel artifacts show ${realHandle}`,
        why: "restored metadata evidence",
      },
    ];
    const checkpointWithDecoyVisibleEvidence = [
      "<conversation-checkpoint>",
      CHECKPOINT_INSTRUCTION,
      "<summary>",
      "Earlier checkpoint restored from disk.",
      "</summary>",
      "Evidence retained:",
      `- ${decoyHandle} | label: bash decoy report | source: complete | inspect: keel artifacts show ${decoyHandle} | why: visible decoy evidence`,
      "</conversation-checkpoint>",
    ].join("\n");
    const persistedMessages: readonly SessionMessage[] = [
      {
        role: "user",
        origin: { type: "compaction_checkpoint" },
        content: checkpointWithDecoyVisibleEvidence,
        contextCompaction: { evidence },
      },
      {
        role: "assistant",
        content: "Resumed from restored checkpoint.",
        toolCalls: [],
      },
      {
        role: "user",
        content: "Continue after restore.",
        origin: { type: "user_prompt" },
      },
    ];

    try {
      const storedSession = createSessionStore({
        sessionId: "restored-compaction-evidence",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session: storedSession,
        previousMessages: [],
        currentMessages: persistedMessages,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      const resumed = resumeSessionStore({
        sessionId: "restored-compaction-evidence",
        workspace,
        runtime: runtime(home, 2),
      });
      const provider: LLMProvider = {
        id: "restored-metadata-evidence-provider",
        async *stream(options) {
          if (options.toolExposure?.kind === "none") {
            yield {
              type: "text",
              text: "Restored metadata summary that omits evidence handles.",
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          const context = JSON.stringify(options.messages);
          const metadataEvidenceSurvived =
            context.includes(realHandle) && !context.includes(decoyHandle);
          yield {
            type: "text",
            text: metadataEvidenceSurvived
              ? "Restored evidence survived."
              : "Restored evidence missing.",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const input = new PassThrough();
      const sigintHandlers = new Set<() => void>();
      let stdout = "";
      let stderr = "";
      const session = runInteractiveSession({
        cliArgs: { executionPosture: "trusted" },
        workspace,
        platform: process.platform,
        session: EPHEMERAL_INTERACTIVE_SESSION,
        initialMessages: resumed.messages,
        input,
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
        onSigint: (handler) => {
          sigintHandlers.add(handler);
        },
        offSigint: (handler) => {
          sigintHandlers.delete(handler);
        },
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
          contextCompaction: {
            keepRecentTokens: 1,
            summaryInputMaxChars: 4_000,
          },
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "text") {
              stdout += event.text;
            } else if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
      });

      // When
      input.end("/compact\ncontinue with restored evidence\n");

      // Then
      await session;
      expect(stdout).toBe("Restored evidence survived.\n");
      expect(stderr).toContain("Context compacted: manual");
      expect(sigintHandlers.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
