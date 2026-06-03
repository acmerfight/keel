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

interface FakeReadResponse {
  readonly type: "read";
  readonly path: string;
  readonly usage: Usage;
}

export type FakeResponse =
  | FakeTextResponse
  | FakeEditResponse
  | FakeReadResponse;

export function fakeResponse(
  text: string,
  tokenize = false,
  usage: Usage = { inputTokens: 0, outputTokens: 0 },
): FakeResponse {
  return { type: "text", text, tokenize, usage };
}

export function fakeEditResponse(
  path: string,
  oldString: string,
  newString: string,
  usage: Usage = { inputTokens: 0, outputTokens: 0 },
): FakeResponse {
  return { type: "edit", path, oldString, newString, usage };
}

export function fakeReadResponse(
  path: string,
  usage: Usage = { inputTokens: 0, outputTokens: 0 },
): FakeResponse {
  return { type: "read", path, usage };
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
        case "read":
          yield {
            type: "tool_call",
            id: `fake_tool_call_${turn}`,
            tool: "read",
            path: response.path,
          };
          break;
      }

      yield { type: "stop", usage: response.usage };
    },
  };
}
