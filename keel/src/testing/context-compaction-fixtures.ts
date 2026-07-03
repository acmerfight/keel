import { createHash } from "node:crypto";
import type { AgentEvent } from "../agent/events.ts";
import type {
  ToolOutputArtifactSourceStatus,
  ToolOutputArtifactStore,
} from "../agent/tool-output-artifacts.ts";
import type { Usage } from "../llm/types.ts";

export type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;
export type ContextCompactedEvent = Extract<
  AgentEvent,
  { readonly type: "context_compacted" }
>;
export type ContextRescueEvent = Extract<
  AgentEvent,
  { readonly type: "context_rescue" }
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

export function contextRescueEvents(
  events: readonly AgentEvent[],
): ContextRescueEvent[] {
  return events.filter(
    (event): event is ContextRescueEvent => event.type === "context_rescue",
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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sourceStatusText(status: ToolOutputArtifactSourceStatus): string {
  return status === "complete"
    ? "complete"
    : "source-truncated/lossy before artifact capture";
}

export function verifiedToolOutputArtifactFixture(options: {
  readonly ref: string;
  readonly toolCallId: string;
  readonly previewContent: string;
  readonly omittedChars: number;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly markerKind?: "tool output shortened" | "stale tool output compacted";
}): {
  readonly marker: string;
  readonly store: ToolOutputArtifactStore;
} {
  const artifactContent = `${options.previewContent}${"x".repeat(
    options.omittedChars,
  )}`;
  const contentSha256 = sha256(artifactContent);
  const markerKind = options.markerKind ?? "tool output shortened";
  const omittedText =
    markerKind === "stale tool output compacted"
      ? `approximately omitted ${options.omittedChars} chars`
      : `omitted ${options.omittedChars} chars`;
  return {
    marker: `[${markerKind}: ${omittedText}; full output artifact: ${options.ref}; inspect with: keel artifacts show ${options.ref}; sha256: ${contentSha256}; source status: ${sourceStatusText(
      options.sourceStatus,
    )}]`,
    store: {
      verifyReusable: async (input) => {
        const expectedChars = input.previewContent.length + input.omittedChars;
        const previewMatches =
          input.previewKind === "prefix"
            ? artifactContent.startsWith(input.previewContent)
            : input.contentSha256 === contentSha256;
        if (
          input.ref !== options.ref ||
          input.toolCallId !== options.toolCallId ||
          input.sourceStatus !== options.sourceStatus ||
          input.omittedChars !== options.omittedChars ||
          artifactContent.length !== expectedChars ||
          (input.contentSha256 !== undefined &&
            input.contentSha256 !== contentSha256) ||
          !previewMatches
        ) {
          return { status: "not_reusable" };
        }
        return { status: "reusable", contentSha256 };
      },
      save: async () => ({
        status: "failed",
        reason: "unexpected artifact save in test",
      }),
    },
  };
}
