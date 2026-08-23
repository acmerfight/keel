import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import { resolveBuiltinSubagentProfile } from "../../src/agent/subagent-profile.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import { createBashPermissionPolicy } from "../../src/permissions/bash.ts";

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("Bash Commands", () => {
  test(`Given Bash is absent from a child capability context,
    When the assistant still requests a shell command,
    Then Runtime rejects it without changing the workspace`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Bash is unavailable."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create a file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          userMessageOrigin: { type: "runtime_subagent_delegation" },
          bash: { kind: "disabled" },
          toolProfile: "subagent",
          workspaceAccess: "read_only",
          subagentCapability:
            resolveBuiltinSubagentProfile("explorer").snapshot,
          costBudgetProvider: provider,
          injectedUserMessages: {
            drain: () => [],
            closeAtTerminalBoundary: () => ({ kind: "closed" }),
          },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(existsSync(join(workspace, "created.txt"))).toBe(false);
      expect(events).toContainEqual({
        type: "text",
        text: "Bash is unavailable.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given trusted local execution,
    When the assistant runs a workspace command,
    Then Runtime executes it and returns the result to the assistant`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Created the file."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create a file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "trusted" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe(
        "changed",
      );
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: { id: "fake_tool_call_1", tool: "bash", command },
        ok: true,
        bashExitCode: 0,
      });
      expect(events).toContainEqual({
        type: "text",
        text: "Created the file.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given reviewed local execution,
    When the user denies the exact command,
    Then Runtime rejects it before any shell effect`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("I will avoid the shell."),
    ]);
    let reviewedCommand = "";

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create a file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: {
            kind: "reviewed",
            permission: createBashPermissionPolicy((request) => {
              reviewedCommand = request.command;
              return { type: "deny", message: "User denied this command." };
            }),
          },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(reviewedCommand).toBe(command);
      expect(existsSync(join(workspace, "created.txt"))).toBe(false);
      expect(events).toContainEqual({
        type: "text",
        text: "I will avoid the shell.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given reviewed local execution allows one command at a time,
    When the assistant repeats an identical command,
    Then Runtime asks the policy again before the second execution`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran twice."),
    ]);
    let reviewCount = 0;

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "run twice",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: {
            kind: "reviewed",
            permission: createBashPermissionPolicy(() => {
              reviewCount++;
              return { type: "allow" };
            }),
          },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(reviewCount).toBe(2);
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
      expect(events).toContainEqual({ type: "text", text: "Ran twice." });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
