import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

async function createGitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-agent-git-diff-"));
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "keel@example.test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Keel Test"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "app.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  await writeFile(join(workspace, "app.ts"), "export const value = 2;\n");
  return workspace;
}

describe("Agent git diff tool use", () => {
  test(`Given bash is disabled and the user asks to inspect current changes,
    When the assistant calls git_diff,
    Then the diff is returned to the model without bash approval`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "agent-git-diff",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "inspect_changes",
            tool: "git_diff",
            mode: "all",
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Reviewed current changes." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "review the current diff",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: {
          id: "inspect_changes",
          tool: "git_diff",
          mode: "all",
        },
        ok: true,
      });
      const toolMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "inspect_changes",
      );
      expect(toolMessage?.content).toContain("diff --git a/app.ts b/app.ts");
      expect(toolMessage?.content).toContain("+export const value = 2;");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
