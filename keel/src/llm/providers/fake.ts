import {
  modelToolExposureAccounting,
  type ToolName,
  toolCallArguments,
  toolCallFromParsedArguments,
} from "../../tools/tool-call.ts";
import type {
  LLMProvider,
  ProviderRequestAttemptFinish,
  Usage,
} from "../types.ts";

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
  args: Record<string, unknown>,
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

export function createFakeProvider(
  script: readonly FakeResponse[],
): LLMProvider {
  let turn = 0;

  return {
    id: "fake",
    estimateInputTokens(options): number {
      return new TextEncoder().encode(
        JSON.stringify({
          systemPrompt: options.systemPrompt,
          messages: options.messages,
          ...modelToolExposureAccounting(options.toolExposure),
        }),
      ).length;
    },
    async *stream(options) {
      options.requestSystemPrompt?.();
      const response = script[turn];
      turn++;

      if (response === undefined) {
        throw new Error("fake provider: script exhausted");
      }

      const attempt = options.providerRequestAttempts?.begin() ?? null;
      let attemptFinished = false;
      const finishAttempt = (result: ProviderRequestAttemptFinish): void => {
        if (attempt === null || attemptFinished) return;
        attemptFinished = true;
        attempt.finish(result);
      };

      try {
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

        finishAttempt({ outcome: "completed", usage: response.usage });
        yield { type: "stop", reason: "stop", usage: response.usage };
      } catch (error) {
        finishAttempt({
          outcome: "terminal_error",
          errorCode: "provider_unexpected_error",
        });
        throw error;
      } finally {
        finishAttempt(
          options.signal.aborted
            ? { outcome: "aborted" }
            : {
                outcome: "terminal_error",
                errorCode: "provider_consumer_closed",
              },
        );
      }
    },
  };
}
