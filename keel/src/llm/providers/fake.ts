import type { LLMProvider, Usage } from "../types.ts";

interface FakeTextResponse {
  readonly type: "text";
  readonly text: string;
  readonly tokenize: boolean;
  readonly usage: Usage;
}

interface FakeEditResponse {
  readonly type: "edit";
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly usage: Usage;
}

interface FakeWriteResponse {
  readonly type: "write";
  readonly path: string;
  readonly content: string;
  readonly usage: Usage;
}

interface FakeReadResponse {
  readonly type: "read";
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly usage: Usage;
}

interface FakeGrepResponse {
  readonly type: "grep";
  readonly pattern: string;
  readonly path?: string;
  readonly usage: Usage;
}

interface FakeGlobResponse {
  readonly type: "glob";
  readonly pattern: string;
  readonly path?: string;
  readonly usage: Usage;
}

interface FakeBashResponse {
  readonly type: "bash";
  readonly command: string;
  readonly timeoutMs?: number;
  readonly usage: Usage;
}

export type FakeResponse =
  | FakeTextResponse
  | FakeEditResponse
  | FakeWriteResponse
  | FakeReadResponse
  | FakeGlobResponse
  | FakeGrepResponse
  | FakeBashResponse;

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

export function fakeEditResponse(
  path: string,
  oldString: string,
  newString: string,
  usage: Usage = ZERO_USAGE,
): FakeResponse {
  return { type: "edit", path, oldString, newString, usage };
}

export function fakeWriteResponse(
  path: string,
  content: string,
  usage: Usage = ZERO_USAGE,
): FakeResponse {
  return { type: "write", path, content, usage };
}

export function fakeReadResponse(
  path: string,
  usage: Usage = ZERO_USAGE,
  options: { readonly offset?: number; readonly limit?: number } = {},
): FakeResponse {
  return {
    type: "read",
    path,
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    usage,
  };
}

export function fakeGrepResponse(
  pattern: string,
  usage: Usage = ZERO_USAGE,
  options: { readonly path?: string } = {},
): FakeResponse {
  return {
    type: "grep",
    pattern,
    ...(options.path !== undefined ? { path: options.path } : {}),
    usage,
  };
}

export function fakeGlobResponse(
  pattern: string,
  usage: Usage = ZERO_USAGE,
  options: { readonly path?: string } = {},
): FakeResponse {
  return {
    type: "glob",
    pattern,
    ...(options.path !== undefined ? { path: options.path } : {}),
    usage,
  };
}

export function fakeBashResponse(
  command: string,
  usage: Usage = ZERO_USAGE,
  options: { readonly timeoutMs?: number } = {},
): FakeResponse {
  return {
    type: "bash",
    command,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    usage,
  };
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
        case "edit":
          yield {
            type: "tool_call",
            id: `fake_tool_call_${turn}`,
            tool: "edit",
            path: response.path,
            oldString: response.oldString,
            newString: response.newString,
          };
          break;
        case "write":
          yield {
            type: "tool_call",
            id: `fake_tool_call_${turn}`,
            tool: "write",
            path: response.path,
            content: response.content,
          };
          break;
        case "read":
          yield {
            type: "tool_call",
            id: `fake_tool_call_${turn}`,
            tool: "read",
            path: response.path,
            ...(response.offset !== undefined
              ? { offset: response.offset }
              : {}),
            ...(response.limit !== undefined ? { limit: response.limit } : {}),
          };
          break;
        case "grep":
          yield {
            type: "tool_call",
            id: `fake_tool_call_${turn}`,
            tool: "grep",
            pattern: response.pattern,
            ...(response.path !== undefined ? { path: response.path } : {}),
          };
          break;
        case "glob":
          yield {
            type: "tool_call",
            id: `fake_tool_call_${turn}`,
            tool: "glob",
            pattern: response.pattern,
            ...(response.path !== undefined ? { path: response.path } : {}),
          };
          break;
        case "bash":
          yield {
            type: "tool_call",
            id: `fake_tool_call_${turn}`,
            tool: "bash",
            command: response.command,
            ...(response.timeoutMs !== undefined
              ? { timeoutMs: response.timeoutMs }
              : {}),
          };
          break;
      }

      yield { type: "stop", usage: response.usage };
    },
  };
}
