import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type {
  LLMProvider,
  ProviderMessage,
  Usage,
} from "../../src/llm/types.ts";

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

async function createGitStatusWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-agent-git-status-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.email", "keel@example.test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Keel Test"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

  await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
  await writeFile(join(workspace, "staged.txt"), "staged\n", "utf8");
  execFileSync("git", ["add", "staged.txt"], { cwd: workspace });
  await writeFile(join(workspace, "untracked.txt"), "untracked\n", "utf8");
  return workspace;
}

describe("Agent git status tool use", () => {
  test(`Given bash is disabled and the user asks to inspect git status,
    When the assistant calls git_status,
    Then the status summary is returned to the model without bash approval`, async () => {
    // Given
    const workspace = await createGitStatusWorkspace();
    let secondTurnMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "agent-git-status",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "inspect_status",
            tool: "git_status",
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Reviewed git status." };
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
          userMessage: "check the git status",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "trusted" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: {
          id: "inspect_status",
          tool: "git_status",
        },
        ok: true,
      });
      const toolMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "inspect_status",
      );
      expect(toolMessage?.content).toContain("Branch: main");
      expect(toolMessage?.content).toContain("Staged changes:");
      expect(toolMessage?.content).toContain("- A staged.txt");
      expect(toolMessage?.content).toContain("Unstaged changes:");
      expect(toolMessage?.content).toContain("- M tracked.txt");
      expect(toolMessage?.content).toContain("Untracked files:");
      expect(toolMessage?.content).toContain("- untracked.txt");
      expect(toolMessage?.content).not.toContain("Tool failed: bash failed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
