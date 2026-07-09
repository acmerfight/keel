import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function createRefComparisonGitWorkspace(): Promise<string> {
  const workspace = await createGitWorkspace();
  execFileSync("git", ["add", "app.ts"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "update app"], { cwd: workspace });
  return workspace;
}

async function createMetadataHeavyGitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(
    join(tmpdir(), "keel-agent-git-diff-metadata-"),
  );
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "keel@example.test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Keel Test"], {
    cwd: workspace,
  });

  await writeFile(join(workspace, ".gitignore"), "bulk/\n", "utf8");
  const bulkDirectory = join(workspace, "bulk");
  await mkdir(bulkDirectory);
  const longName = "x".repeat(180);

  for (let index = 0; index < 620; index += 1) {
    await writeFile(
      join(
        bulkDirectory,
        `ignored-${String(index).padStart(4, "0")}-${longName}.txt`,
      ),
      "base\n",
      "utf8",
    );
  }
  await writeFile(join(workspace, "zz-target.ts"), "export const value = 1;\n");

  execFileSync("git", ["add", ".gitignore", "zz-target.ts"], {
    cwd: workspace,
  });
  execFileSync("git", ["add", "-f", "bulk"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

  for (let index = 0; index < 620; index += 1) {
    await writeFile(
      join(
        bulkDirectory,
        `ignored-${String(index).padStart(4, "0")}-${longName}.txt`,
      ),
      "changed\n",
      "utf8",
    );
  }
  await writeFile(
    join(workspace, "zz-target.ts"),
    "export const value = 'TARGET_METADATA_SENTINEL';\n",
    "utf8",
  );

  return workspace;
}

async function createSemanticMetadataGitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(
    join(tmpdir(), "keel-agent-git-diff-semantic-"),
  );
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "keel@example.test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Keel Test"], {
    cwd: workspace,
  });

  await mkdir(join(workspace, "assets"));
  await mkdir(join(workspace, "scripts"));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "old.ts"), "export const old = 1;\n");
  await writeFile(join(workspace, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  await writeFile(
    join(workspace, "assets", "blob.bin"),
    Buffer.from([0, 1, 2, 3]),
  );
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

  execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], {
    cwd: workspace,
  });
  await chmod(join(workspace, "scripts", "run.sh"), 0o755);
  await writeFile(
    join(workspace, "assets", "blob.bin"),
    Buffer.from([0, 4, 5, 6]),
  );
  execFileSync("git", ["add", "scripts/run.sh", "assets/blob.bin"], {
    cwd: workspace,
  });

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

  test(`Given bash is disabled and the user asks to compare committed refs,
    When the assistant calls git_diff with baseRef and headRef,
    Then the committed diff is returned to the model without bash approval`, async () => {
    // Given
    const workspace = await createRefComparisonGitWorkspace();
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "agent-git-diff-refs",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "compare_refs",
            tool: "git_diff",
            baseRef: "HEAD~1",
            headRef: "HEAD",
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Reviewed committed changes." };
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
          userMessage: "review the last commit diff",
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
          id: "compare_refs",
          tool: "git_diff",
          baseRef: "HEAD~1",
          headRef: "HEAD",
        },
        ok: true,
      });
      const toolMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "compare_refs",
      );
      expect(toolMessage?.content).toContain("Ref comparison (HEAD~1..HEAD):");
      expect(toolMessage?.content).toContain("diff --git a/app.ts b/app.ts");
      expect(toolMessage?.content).toContain("+export const value = 2;");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given staged rename mode and binary changes,
    When the assistant calls git_diff with bash disabled,
    Then semantic diff metadata is returned to the model`, async () => {
    // Given
    const workspace = await createSemanticMetadataGitWorkspace();
    const provider: LLMProvider = {
      id: "agent-git-diff-semantic-metadata",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "inspect_semantic_changes",
            tool: "git_diff",
            mode: "all",
          };
        } else {
          const toolMessage = options.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "inspect_semantic_changes",
          );
          const metadataVisible =
            toolMessage?.content.includes(
              "diff --git a/src/old.ts b/src/new.ts",
            ) === true &&
            toolMessage.content.includes("rename from src/old.ts") &&
            toolMessage.content.includes("rename to src/new.ts") &&
            toolMessage.content.includes("old mode 100644") &&
            toolMessage.content.includes("new mode 100755") &&
            toolMessage.content.includes(
              "Binary files a/assets/blob.bin and b/assets/blob.bin differ",
            );
          yield {
            type: "text",
            text: metadataVisible
              ? "Semantic metadata found."
              : "Semantic metadata missing.",
          };
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
        type: "text",
        text: "Semantic metadata found.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git_diff metadata output exceeds the producer preview cap,
    When the assistant inspects current changes,
    Then a visible late path still reaches the model diff`, async () => {
    // Given
    const workspace = await createMetadataHeavyGitWorkspace();
    const provider: LLMProvider = {
      id: "agent-git-diff-large-metadata",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "inspect_metadata_heavy_changes",
            tool: "git_diff",
            mode: "all",
          };
        } else {
          const toolMessage = options.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "inspect_metadata_heavy_changes",
          );
          const latePathVisible =
            toolMessage?.content.includes(
              "diff --git a/zz-target.ts b/zz-target.ts",
            ) === true &&
            toolMessage.content.includes("TARGET_METADATA_SENTINEL") &&
            !toolMessage.content.includes("bulk/ignored-");
          yield {
            type: "text",
            text: latePathVisible
              ? "Late visible diff found."
              : "Late visible diff missing.",
          };
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
        type: "text",
        text: "Late visible diff found.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 10_000);
});
