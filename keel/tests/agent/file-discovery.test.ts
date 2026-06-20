import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";

const ZERO_USAGE = {
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

describe("File Discovery", () => {
  test(`Given the assistant needs to discover files by name,
    When the agent runs the glob tool,
    Then the discovered path is returned as tool output before the final answer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-discovery-"));
    await mkdir(join(workspace, "tests"), { recursive: true });
    await writeFile(
      join(workspace, "tests", "validator.test.ts"),
      "assert(isSlug('docs-v2'));\n",
      "utf8",
    );
    const provider = createFakeProvider([
      fakeToolResponse(
        "glob",
        {
          pattern: "**/*validator*.test.ts",
          path: "tests",
        },
        ZERO_USAGE,
      ),
      fakeResponse("Found the validator test."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "find validator tests",
          systemPrompt: "You are a helpful assistant.",
          signal: new AbortController().signal,
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: {
          id: "fake_tool_call_1",
          tool: "glob",
          pattern: "**/*validator*.test.ts",
          path: "tests",
        },
        ok: true,
      });
      expect(events).toContainEqual({
        type: "text",
        text: "Found the validator test.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user asks about a known directory,
    When the assistant lists the directory before reading a file,
    Then the directory entries are available to the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-discovery-"));
    await mkdir(join(workspace, "src", "tools"), { recursive: true });
    await writeFile(
      join(workspace, "src", "tools", "edit.ts"),
      "export const edit = true;\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "src", "tools", "glob.ts"),
      "export const glob = true;\n",
      "utf8",
    );

    let turn = 0;
    let afterLsMessages: readonly Message[] = [];
    let afterReadMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "directory-discovery-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "list_tools",
            tool: "ls",
            path: "src/tools",
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          afterLsMessages = options.messages;
          yield {
            type: "tool_call",
            id: "read_edit_tool",
            tool: "read",
            path: "src/tools/edit.ts",
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        afterReadMessages = options.messages;
        yield { type: "text", text: "Listed and read the edit tool." };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect src/tools",
          systemPrompt: "You are a helpful assistant.",
          signal: new AbortController().signal,
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(afterLsMessages).toContainEqual({
        role: "tool",
        toolCallId: "list_tools",
        content: ["edit.ts", "glob.ts"].join("\n"),
      });
      expect(afterReadMessages).toContainEqual({
        role: "tool",
        toolCallId: "read_edit_tool",
        content: "export const edit = true;\n",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "Listed and read the edit tool.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user asks about files by name pattern,
    When the assistant discovers matching files before reading one,
    Then the discovered path is available to the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-discovery-"));
    await mkdir(join(workspace, "tests"), { recursive: true });
    await writeFile(
      join(workspace, "tests", "validator.test.ts"),
      "assert(isSlug('docs-v2'));\n",
      "utf8",
    );
    await writeFile(join(workspace, "src.ts"), "not a test\n", "utf8");

    let turn = 0;
    let afterGlobMessages: readonly Message[] = [];
    let afterReadMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "file-discovery-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "find_tests",
            tool: "glob",
            pattern: "**/*validator*.test.ts",
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          afterGlobMessages = options.messages;
          yield {
            type: "tool_call",
            id: "read_test",
            tool: "read",
            path: "tests/validator.test.ts",
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        afterReadMessages = options.messages;
        yield { type: "text", text: "Found and read the validator test." };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect validator tests",
          systemPrompt: "You are a helpful assistant.",
          signal: new AbortController().signal,
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(afterGlobMessages).toContainEqual({
        role: "tool",
        toolCallId: "find_tests",
        content: "tests/validator.test.ts",
      });
      expect(afterReadMessages).toContainEqual({
        role: "tool",
        toolCallId: "read_test",
        content: "assert(isSlug('docs-v2'));\n",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "Found and read the validator test.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
