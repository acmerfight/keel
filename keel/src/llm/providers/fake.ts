import type { LLMProvider, Usage } from "../types.ts";

export interface FakeResponse {
  readonly text: string;
  readonly tokenize: boolean;
  readonly usage: Usage;
}

export function fakeResponse(
  text: string,
  tokenize = false,
  usage: Usage = { inputTokens: 0, outputTokens: 0 },
): FakeResponse {
  return { text, tokenize, usage };
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

      if (response.tokenize) {
        for (const char of response.text) {
          yield { type: "text", text: char };
        }
      } else {
        yield { type: "text", text: response.text };
      }

      yield { type: "stop", usage: response.usage };
    },
  };
}
