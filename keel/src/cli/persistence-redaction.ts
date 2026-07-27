import { copyReadResourceObservation } from "../core/resource-observation.ts";
import {
  redactSecretLikeText,
  SECRET_REDACTION_MARKER,
} from "../core/secret-text.ts";
import type {
  AssistantProviderMetadata,
  Message,
  SessionMessage,
  UserMessageContextCompactionMetadata,
  UserMessageOrigin,
} from "../llm/types.ts";
import {
  isMcpToolInvocation,
  type McpToolArguments,
  type ToolCall,
  type ToolJsonValue,
  toolCallCanonicalArguments,
  toolCallFromParsedArguments,
} from "../tools/registry.ts";

export function redactTextForPersistence(text: string): string {
  return redactSecretLikeText(text);
}

export function hasPersistenceRedactionMarker(text: string): boolean {
  return text.includes(SECRET_REDACTION_MARKER);
}

function redactUnknownForPersistence(value: unknown): unknown {
  if (typeof value === "string") {
    return redactTextForPersistence(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactUnknownForPersistence);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = redactUnknownForPersistence(nestedValue);
  }
  return redacted;
}

function redactToolJsonValueForPersistence(
  value: ToolJsonValue,
): ToolJsonValue {
  if (typeof value === "string") {
    return redactTextForPersistence(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactToolJsonValueForPersistence);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, ToolJsonValue> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = redactToolJsonValueForPersistence(nestedValue);
  }
  return redacted;
}

function redactMcpToolArgumentsForPersistence(
  argumentsValue: McpToolArguments,
): McpToolArguments {
  const redacted: Record<string, ToolJsonValue> = {};
  for (const [key, value] of Object.entries(argumentsValue)) {
    redacted[key] = redactToolJsonValueForPersistence(value);
  }
  return redacted;
}

function redactToolCallForPersistence(toolCall: ToolCall): ToolCall {
  if (isMcpToolInvocation(toolCall)) {
    return {
      ...toolCall,
      arguments: redactMcpToolArgumentsForPersistence(toolCall.arguments),
    };
  }
  const redacted = toolCallFromParsedArguments(
    toolCall.id,
    toolCall.tool,
    redactUnknownForPersistence(toolCallCanonicalArguments(toolCall)),
  );
  /* v8 ignore next 3: redaction only replaces strings with strings, preserving each tool schema shape. */
  if (redacted === null) {
    throw new Error("redacted tool call failed validation");
  }
  return redacted;
}

function redactAssistantProviderMetadataForPersistence(
  providerMetadata: AssistantProviderMetadata,
): AssistantProviderMetadata {
  return {
    openaiCompatible: {
      reasoningContent: redactTextForPersistence(
        providerMetadata.openaiCompatible.reasoningContent,
      ),
    },
  };
}

function redactUserContextCompactionMetadataForPersistence(
  metadata: UserMessageContextCompactionMetadata,
): UserMessageContextCompactionMetadata {
  return {
    evidence: metadata.evidence.map((evidence) => ({
      handle: redactTextForPersistence(evidence.handle),
      label: redactTextForPersistence(evidence.label),
      source: redactTextForPersistence(evidence.source),
      why: redactTextForPersistence(evidence.why),
      ...(evidence.inspectCommand === undefined
        ? {}
        : {
            inspectCommand: redactTextForPersistence(evidence.inspectCommand),
          }),
    })),
    ...(metadata.untrustedMcpContent === true
      ? { untrustedMcpContent: true }
      : {}),
  };
}

function copyUserMessageOrigin(origin: UserMessageOrigin): UserMessageOrigin {
  return { type: origin.type };
}

export function redactMessageForPersistence(
  message: SessionMessage,
): SessionMessage;
export function redactMessageForPersistence(message: Message): Message;
export function redactMessageForPersistence(message: Message): Message {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: redactTextForPersistence(message.content),
        ...(message.origin === undefined
          ? {}
          : { origin: copyUserMessageOrigin(message.origin) }),
        ...(message.contextCompaction === undefined
          ? {}
          : {
              contextCompaction:
                redactUserContextCompactionMetadataForPersistence(
                  message.contextCompaction,
                ),
            }),
      };
    case "assistant":
      return {
        role: "assistant",
        content: redactTextForPersistence(message.content),
        toolCalls: message.toolCalls.map(redactToolCallForPersistence),
        ...(message.providerMetadata !== undefined
          ? {
              providerMetadata: redactAssistantProviderMetadataForPersistence(
                message.providerMetadata,
              ),
            }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        content: redactTextForPersistence(message.content),
        ...(message.sourceTruncated !== undefined
          ? { sourceTruncated: message.sourceTruncated }
          : {}),
        ...(message.resourceObservation !== undefined
          ? {
              resourceObservation: copyReadResourceObservation(
                message.resourceObservation,
              ),
            }
          : {}),
      };
  }
}
