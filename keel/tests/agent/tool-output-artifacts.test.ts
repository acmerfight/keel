import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../src/agent/tool-output-artifacts.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";
import {
  commitFile,
  createGitWorkspace,
  runGit,
} from "../../src/testing/cli-harness.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

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

function toolMessages(
  messages: readonly Message[],
): readonly Extract<Message, { readonly role: "tool" }>[] {
  return messages.filter((message) => message.role === "tool");
}

function artifactStoreSavingTo(
  saved: ToolOutputArtifactSaveInput[],
): ToolOutputArtifactStore {
  return {
    verifyReusable: async () => ({ status: "not_reusable" }),
    save: async (input) => {
      saved.push(input);
      return {
        status: "stored",
        ref: `tool-output:test/${saved.length}`,
        contentSha256: "0".repeat(64),
      };
    },
    discard: async () => {
      saved.pop();
    },
  };
}

function largeBashCommand(): string {
  const script = [
    "const filler = Array.from({ length: 9000 }, (_, index) => 'BASH_FILLER_' + String(index).padStart(4, '0') + '_' + 'x'.repeat(50)).join('\\n');",
    "process.stdout.write(['BASH_HEAD_SENTINEL', filler, 'BASH_MIDDLE_SENTINEL', filler, 'BASH_TAIL_SENTINEL'].join('\\n'));",
  ].join("");
  return `node -e ${JSON.stringify(script)}`;
}

function overArtifactCapBashCommand(): string {
  const script = [
    "process.stdout.write('BASH_CAP_HEAD_SENTINEL\\n');",
    "process.stdout.write('y'.repeat(10_100_000));",
    "process.stdout.write('\\nBASH_CAP_TAIL_SENTINEL');",
  ].join("");
  return `node -e ${JSON.stringify(script)}`;
}

function largeGitDiffContent(): string {
  return [
    "base",
    ...Array.from(
      { length: 20_000 },
      (_, index) =>
        `GIT_DIFF_FILLER_${String(index).padStart(5, "0")}_${"x".repeat(50)}`,
    ),
    "GIT_DIFF_LATE_SENTINEL",
    "",
  ].join("\n");
}

function overArtifactCapGitDiffContent(): string {
  return [
    "GIT_DIFF_CAP_HEAD_SENTINEL",
    "z".repeat(10_100_000),
    "GIT_DIFF_CAP_TAIL_SENTINEL",
    "",
  ].join("\n");
}

async function writeUntrackedFiles(
  workspace: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      join(workspace, `untracked-${index}.txt`),
      `UNTRACKED_${index}\n`,
      "utf8",
    );
  }
}

describe("Agent Tool Output Artifacts", () => {
  test(`Given a bash tool result exceeds the producer preview cap,
    When Keel artifacts the model-visible tool result,
    Then the user can inspect a complete artifact while the model sees a bounded preview`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-bash-artifact-"));
    const saved: ToolOutputArtifactSaveInput[] = [];
    const messages: Message[] = [
      { role: "user", content: "run the noisy command" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "complete-bash-artifact-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "noisy_bash",
            tool: "bash",
            command: largeBashCommand(),
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const savedArtifact = saved[0];
        const previewIsBounded =
          toolMessage !== undefined &&
          savedArtifact !== undefined &&
          toolMessage.content.includes("full output artifact: tool-output:") &&
          toolMessage.content.includes("source status: complete") &&
          toolMessage.content.length < savedArtifact.content.length;
        yield {
          type: "text",
          text: previewIsBounded
            ? "bash artifact visible"
            : "bash artifact missing",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: artifactStoreSavingTo(saved),
            maxInlineChars: 1_000,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "bash artifact visible",
      });
      expect(saved).toHaveLength(1);
      expect(saved[0]?.toolName).toBe("bash");
      expect(saved[0]?.toolCallId).toBe("noisy_bash");
      expect(saved[0]?.sourceStatus).toBe("complete");
      expect(saved[0]?.content).toContain("BASH_HEAD_SENTINEL");
      expect(saved[0]?.content).toContain("BASH_MIDDLE_SENTINEL");
      expect(saved[0]?.content).toContain("BASH_TAIL_SENTINEL");
      expect(saved[0]?.content).not.toContain(
        "[bash stdout truncated: showing first",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a bash tool result exceeds the artifact capture cap,
    When Keel artifacts the model-visible tool result,
    Then the user sees a bounded lossy artifact instead of an unbounded capture`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-bash-capped-"));
    const saved: ToolOutputArtifactSaveInput[] = [];
    const messages: Message[] = [
      { role: "user", content: "run the oversized command" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "capped-bash-artifact-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "oversized_bash",
            tool: "bash",
            command: overArtifactCapBashCommand(),
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const lossyArtifact =
          toolMessage?.sourceTruncated === true &&
          toolMessage.content.includes("full output artifact: tool-output:") &&
          toolMessage.content.includes(
            "source status: source-truncated/lossy before artifact capture",
          );
        yield {
          type: "text",
          text: lossyArtifact
            ? "bash artifact marked lossy"
            : "bash artifact marker missing",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: artifactStoreSavingTo(saved),
            maxInlineChars: 1_000,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "bash artifact marked lossy",
      });
      expect(saved).toHaveLength(1);
      expect(saved[0]?.sourceStatus).toBe("source-truncated");
      expect(saved[0]?.content).toContain("BASH_CAP_HEAD_SENTINEL");
      expect(saved[0]?.content).not.toContain("BASH_CAP_TAIL_SENTINEL");
      expect(saved[0]?.content).toContain(
        "[bash stdout truncated: showing first 10000000 bytes]",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a bash tool result exceeds the producer preview cap without artifact storage,
    When Keel sends the tool result back to the model,
    Then the model still sees the bounded producer preview`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-bash-no-artifact-"));
    const messages: Message[] = [
      { role: "user", content: "run the noisy command" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "bounded-bash-preview-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "noisy_bash",
            tool: "bash",
            command: largeBashCommand(),
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const previewIsBounded =
          toolMessage?.content.includes(
            "[bash stdout truncated: showing last 20000 bytes]",
          ) === true &&
          toolMessage.content.includes("BASH_TAIL_SENTINEL") &&
          !toolMessage.content.includes("BASH_HEAD_SENTINEL") &&
          !toolMessage.content.includes("full output artifact:");
        yield {
          type: "text",
          text: previewIsBounded
            ? "bash preview bounded"
            : "bash preview leaked",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "bash preview bounded",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a complete bash tool result fits the inline artifact budget,
    When Keel settles the model-visible tool result,
    Then the model sees the full result without saving an artifact`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-bash-inline-"));
    const saved: ToolOutputArtifactSaveInput[] = [];
    const messages: Message[] = [
      { role: "user", content: "run the small command" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "small-bash-inline-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "small_bash",
            tool: "bash",
            command: `node -e "process.stdout.write('SMALL_COMPLETE_SENTINEL')"`,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const inlineResult =
          saved.length === 0 &&
          toolMessage?.content.includes("SMALL_COMPLETE_SENTINEL") === true &&
          !toolMessage.content.includes("full output artifact:");
        yield {
          type: "text",
          text: inlineResult ? "small output inline" : "small output saved",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: artifactStoreSavingTo(saved),
            maxInlineChars: 1_000,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "small output inline",
      });
      expect(saved).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given artifact storage fails for a projected bash tool result,
    When Keel sends the tool result back to the model,
    Then the model sees a lossy storage failure marker`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-bash-failed-save-"));
    const messages: Message[] = [
      { role: "user", content: "run the noisy command" },
    ];
    const store: ToolOutputArtifactStore = {
      verifyReusable: async () => ({ status: "not_reusable" }),
      save: async () => ({
        status: "failed",
        reason: "test artifact store is unavailable",
      }),
      discard: async () => {},
    };
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "failed-projected-artifact-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "noisy_bash",
            tool: "bash",
            command: largeBashCommand(),
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const failureVisible =
          toolMessage?.sourceTruncated === true &&
          toolMessage.content.includes("[tool output projected:") &&
          toolMessage.content.includes(
            "artifact storage failed: test artifact store is unavailable",
          ) &&
          toolMessage.content.includes(
            "rerun the tool with narrower parameters if needed",
          );
        yield {
          type: "text",
          text: failureVisible
            ? "failed artifact marked lossy"
            : "failed artifact marker missing",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store,
            maxInlineChars: 1_000,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "failed artifact marked lossy",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a git_diff output exceeds the producer preview cap,
    When Keel artifacts the model-visible tool result,
    Then the user can inspect the full late diff content from the artifact`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-artifact-");
    await commitFile(workspace, "large.txt", "base\n");
    await writeFile(
      join(workspace, "large.txt"),
      largeGitDiffContent(),
      "utf8",
    );
    await runGit(workspace, ["status", "--short"]);
    const saved: ToolOutputArtifactSaveInput[] = [];
    const messages: Message[] = [
      { role: "user", content: "inspect the large diff" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "complete-git-diff-artifact-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "large_diff",
            tool: "git_diff",
            mode: "all",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const savedArtifact = saved[0];
        const previewIsBounded =
          toolMessage !== undefined &&
          savedArtifact !== undefined &&
          toolMessage.content.includes("full output artifact: tool-output:") &&
          toolMessage.content.includes("source status: complete") &&
          toolMessage.content.length < savedArtifact.content.length;
        yield {
          type: "text",
          text: previewIsBounded
            ? "git diff artifact visible"
            : "git diff artifact missing",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: artifactStoreSavingTo(saved),
            maxInlineChars: 1_000,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "git diff artifact visible",
      });
      expect(saved).toHaveLength(1);
      expect(saved[0]?.toolName).toBe("git_diff");
      expect(saved[0]?.toolCallId).toBe("large_diff");
      expect(saved[0]?.sourceStatus).toBe("complete");
      expect(saved[0]?.content).toContain("diff --git a/large.txt b/large.txt");
      expect(saved[0]?.content).toContain("GIT_DIFF_LATE_SENTINEL");
      expect(saved[0]?.content).not.toContain(
        "[git_diff stdout truncated: showing first",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a git_diff result exceeds the artifact capture cap,
    When Keel artifacts the model-visible tool result,
    Then the user sees a bounded lossy diff artifact instead of an unbounded capture`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-capped-");
    await writeFile(
      join(workspace, "oversized.txt"),
      overArtifactCapGitDiffContent(),
      "utf8",
    );
    const saved: ToolOutputArtifactSaveInput[] = [];
    const messages: Message[] = [
      { role: "user", content: "inspect the oversized diff" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "capped-git-diff-artifact-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "oversized_diff",
            tool: "git_diff",
            mode: "all",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const lossyArtifact =
          toolMessage?.sourceTruncated === true &&
          toolMessage.content.includes("full output artifact: tool-output:") &&
          toolMessage.content.includes(
            "source status: source-truncated/lossy before artifact capture",
          );
        yield {
          type: "text",
          text: lossyArtifact
            ? "git diff artifact marked capture-capped"
            : "git diff artifact cap marker missing",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: artifactStoreSavingTo(saved),
            maxInlineChars: 1_000,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "git diff artifact marked capture-capped",
      });
      expect(saved).toHaveLength(1);
      expect(saved[0]?.sourceStatus).toBe("source-truncated");
      expect(saved[0]?.content).toContain("GIT_DIFF_CAP_HEAD_SENTINEL");
      expect(saved[0]?.content).not.toContain("GIT_DIFF_CAP_TAIL_SENTINEL");
      expect(saved[0]?.content).toContain(
        "[git_diff stdout truncated: showing first 10000000 bytes]",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a git_diff output exceeds the producer preview cap without artifact storage,
    When Keel sends the tool result back to the model,
    Then the model still sees the bounded producer preview`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-no-artifact-");
    await commitFile(workspace, "large.txt", "base\n");
    await writeFile(
      join(workspace, "large.txt"),
      largeGitDiffContent(),
      "utf8",
    );
    const messages: Message[] = [
      { role: "user", content: "inspect the large diff" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "bounded-git-diff-preview-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "large_diff",
            tool: "git_diff",
            mode: "all",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const previewIsBounded =
          toolMessage?.content.includes(
            "[git_diff stdout truncated: showing first 100000 bytes]",
          ) === true &&
          toolMessage.content.includes("diff --git a/large.txt b/large.txt") &&
          !toolMessage.content.includes("GIT_DIFF_LATE_SENTINEL") &&
          !toolMessage.content.includes("full output artifact:");
        yield {
          type: "text",
          text: previewIsBounded
            ? "git diff preview bounded"
            : "git diff preview leaked",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "git diff preview bounded",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git_diff omits untracked files before artifact capture,
    When Keel artifacts the model-visible tool result,
    Then the model sees a source-truncated artifact marker`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-lossy-artifact-");
    await writeUntrackedFiles(workspace, 51);
    const saved: ToolOutputArtifactSaveInput[] = [];
    const messages: Message[] = [
      { role: "user", content: "inspect untracked files" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "source-truncated-git-diff-artifact-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "many_untracked",
            tool: "git_diff",
            mode: "all",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const lossyArtifact =
          toolMessage?.sourceTruncated === true &&
          toolMessage.content.includes("full output artifact: tool-output:") &&
          toolMessage.content.includes(
            "source status: source-truncated/lossy before artifact capture",
          );
        yield {
          type: "text",
          text: lossyArtifact
            ? "git diff artifact marked lossy"
            : "git diff artifact marker missing",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: artifactStoreSavingTo(saved),
            maxInlineChars: 1_000,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "git diff artifact marked lossy",
      });
      expect(saved).toHaveLength(1);
      expect(saved[0]?.sourceStatus).toBe("source-truncated");
      expect(saved[0]?.content).toContain(
        "[git_diff output truncated: showing first 50 untracked files.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git_diff omits untracked files but fits the inline artifact budget,
    When Keel settles the model-visible tool result,
    Then the model sees the source-truncated result without saving an artifact`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-lossy-inline-");
    await writeUntrackedFiles(workspace, 51);
    const saved: ToolOutputArtifactSaveInput[] = [];
    const messages: Message[] = [
      { role: "user", content: "inspect untracked files" },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "source-truncated-git-diff-inline-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "many_untracked",
            tool: "git_diff",
            mode: "all",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const [toolMessage] = toolMessages(options.messages);
        const inlineLossy =
          saved.length === 0 &&
          toolMessage?.sourceTruncated === true &&
          toolMessage.content.includes(
            "[git_diff output truncated: showing first 50 untracked files.",
          ) &&
          !toolMessage.content.includes("full output artifact:");
        yield {
          type: "text",
          text: inlineLossy
            ? "git diff lossy result inline"
            : "git diff lossy result saved",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: artifactStoreSavingTo(saved),
            maxInlineChars: 1_000_000,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "git diff lossy result inline",
      });
      expect(saved).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one turn has several medium outputs over the aggregate budget,
    When Keel settles the tool results,
    Then it artifacts the largest outputs until the turn is back under budget`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-artifacts-"));
    await writeFile(
      join(workspace, "first.log"),
      ["FIRST_START", "a".repeat(700), "FIRST_END"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, "second.log"),
      ["SECOND_START", "b".repeat(700), "SECOND_END"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, "third.log"),
      ["THIRD_START", "c".repeat(700), "THIRD_END"].join("\n"),
      "utf8",
    );
    const saved: ToolOutputArtifactSaveInput[] = [];
    const store: ToolOutputArtifactStore = {
      verifyReusable: async () => ({ status: "not_reusable" }),
      save: async (input) => {
        saved.push(input);
        return {
          status: "stored",
          ref: `tool-output:test/${saved.length}`,
          contentSha256: "0".repeat(64),
        };
      },
      discard: async () => {
        saved.pop();
      },
    };
    const messages: Message[] = [{ role: "user", content: "inspect the logs" }];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "aggregate-largest-artifact-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "read_first",
            tool: "read",
            path: "first.log",
          };
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.log",
          };
          yield {
            type: "tool_call",
            id: "read_third",
            tool: "read",
            path: "third.log",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const toolMessages = options.messages.filter(
          (message) => message.role === "tool",
        );
        const aggregateHandled =
          toolMessages[0]?.content.includes("keel artifacts show") === true &&
          toolMessages[1]?.content.includes("keel artifacts show") === true &&
          toolMessages[2]?.content.includes("THIRD_END") === true &&
          toolMessages[2]?.content.includes("keel artifacts show") === false;
        yield {
          type: "text",
          text: aggregateHandled ? "aggregate handled" : "aggregate missing",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store,
            maxInlineChars: 1_000,
            maxAggregateInlineChars: 1_000,
            aggregatePreviewChars: 10,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "aggregate handled",
      });
      expect(saved.map((artifact) => artifact.toolCallId)).toEqual([
        "read_first",
        "read_second",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
