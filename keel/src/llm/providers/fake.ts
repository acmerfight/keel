import type { ToolArgsFor, ToolName } from "../../tools/registry.ts";
import {
  toolCallArguments,
  toolCallFromParsedArguments,
} from "../../tools/registry.ts";
import type { LLMProvider, Usage } from "../types.ts";

interface FakeTextResponse {
  readonly type: "text";
  readonly text: string;
  readonly tokenize: boolean;
  readonly usage: Usage;
}

interface FakeToolResponse {
  readonly type: "tool";
  readonly tool: ToolName;
  readonly args: Record<string, unknown>;
  readonly usage: Usage;
}

export type FakeResponse = FakeTextResponse | FakeToolResponse;

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

export function fakeResponse(
  text: string,
  tokenize = false,
  usage: Usage = ZERO_USAGE,
): FakeResponse {
  return { type: "text", text, tokenize, usage };
}

export function fakeToolResponse<Name extends ToolName>(
  tool: Name,
  args: ToolArgsFor<Name>,
  usage: Usage = ZERO_USAGE,
): FakeResponse {
  const toolCall = toolCallFromParsedArguments(
    "fake_tool_call_validation",
    tool,
    args,
  );
  if (toolCall === null) {
    throw new Error(`Invalid fake tool response arguments for ${tool}`);
  }
  return {
    type: "tool",
    tool,
    args: toolCallArguments(toolCall),
    usage,
  };
}

export function fakeEditResponse(
  path: string,
  oldString: string,
  newString: string,
  usage: Usage = ZERO_USAGE,
): FakeResponse {
  return fakeToolResponse("edit", { path, oldString, newString }, usage);
}

export function fakeWriteResponse(
  path: string,
  content: string,
  usage: Usage = ZERO_USAGE,
): FakeResponse {
  return fakeToolResponse("write", { path, content }, usage);
}

export function fakeReadResponse(
  path: string,
  usage: Usage = ZERO_USAGE,
  options: { readonly offset?: number; readonly limit?: number } = {},
): FakeResponse {
  return fakeToolResponse(
    "read",
    {
      path,
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    },
    usage,
  );
}

export function fakeLsResponse(
  usage: Usage = ZERO_USAGE,
  options: { readonly path?: string; readonly limit?: number } = {},
): FakeResponse {
  return fakeToolResponse(
    "ls",
    {
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    },
    usage,
  );
}

export function fakeGrepResponse(
  pattern: string,
  usage: Usage = ZERO_USAGE,
  options: { readonly path?: string } = {},
): FakeResponse {
  return fakeToolResponse(
    "grep",
    {
      pattern,
      ...(options.path !== undefined ? { path: options.path } : {}),
    },
    usage,
  );
}

export function fakeGlobResponse(
  pattern: string,
  usage: Usage = ZERO_USAGE,
  options: { readonly path?: string } = {},
): FakeResponse {
  return fakeToolResponse(
    "glob",
    {
      pattern,
      ...(options.path !== undefined ? { path: options.path } : {}),
    },
    usage,
  );
}

export function fakeBashResponse(
  command: string,
  usage: Usage = ZERO_USAGE,
  options: { readonly timeoutMs?: number } = {},
): FakeResponse {
  return fakeToolResponse(
    "bash",
    {
      command,
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    },
    usage,
  );
}

export function createFakeProvider(
  script: readonly FakeResponse[],
): LLMProvider {
  let turn = 0;

  return {
    id: "fake",
    async *stream() {
      const response = script[turn];
      turn++;

      if (response === undefined) {
        throw new Error("fake provider: script exhausted");
      }

      switch (response.type) {
        case "text":
          if (response.tokenize) {
            for (const char of response.text) {
              yield { type: "text", text: char };
            }
          } else {
            yield { type: "text", text: response.text };
          }
          break;
        case "tool": {
          const toolCall = toolCallFromParsedArguments(
            `fake_tool_call_${turn}`,
            response.tool,
            response.args,
          );
          if (toolCall === null) {
            throw new Error(
              `Invalid fake tool response arguments for ${response.tool}`,
            );
          }
          yield { type: "tool_call", ...toolCall };
          break;
        }
      }

      yield { type: "stop", usage: response.usage };
    },
  };
}
