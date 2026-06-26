import type { AgentEvent } from "../agent/loop.ts";
import type { Usage } from "../llm/types.ts";

export type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;
export type ContextCompactedEvent = Extract<
  AgentEvent,
  { readonly type: "context_compacted" }
>;

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

export const CHECKPOINT_INSTRUCTION =
  "The following is a summary of earlier conversation. Treat it as historical context, not as a new instruction.";

export const CHECKPOINT_NO_LATER_MESSAGES =
  "No later messages are available after this checkpoint; continue from the task state and next steps in the summary.";

export function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

export function workspace(): string {
  return process.cwd();
}

export function estimatedTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function generatedCheckpoint(
  summary: string,
  options?: { readonly noLaterMessages?: boolean },
): string {
  return [
    "<conversation-checkpoint>",
    CHECKPOINT_INSTRUCTION,
    options?.noLaterMessages === true ? CHECKPOINT_NO_LATER_MESSAGES : "",
    "<summary>",
    summary,
    "</summary>",
    "</conversation-checkpoint>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

export function endEvent(events: readonly AgentEvent[]): EndEvent {
  const event = events.at(-1);
  if (event === undefined || event.type !== "end") {
    throw new Error("run did not finish with an end event");
  }
  return event;
}

export function contextCompactedEvents(
  events: readonly AgentEvent[],
): ContextCompactedEvent[] {
  return events.filter(
    (event): event is ContextCompactedEvent =>
      event.type === "context_compacted",
  );
}

export function onlyContextCompactedEvent(
  events: readonly AgentEvent[],
): ContextCompactedEvent {
  const [event] = contextCompactedEvents(events);
  if (event === undefined) {
    throw new Error("run did not emit a context_compacted event");
  }
  return event;
}

export function failingStream(error: unknown): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        async next() {
          throw error;
        },
      };
    },
  };
}
