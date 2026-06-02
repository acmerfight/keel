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

export type FakeResponse = FakeTextResponse | FakeEditResponse;

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
            tool: "edit",
            path: response.path,
            oldString: response.oldString,
            newString: response.newString,
          };
          break;
      }

      yield { type: "stop", usage: response.usage };
    },
  };
}
