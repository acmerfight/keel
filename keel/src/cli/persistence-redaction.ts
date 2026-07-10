import { copyReadResourceObservation } from "../core/resource-observation.ts";
import type {
  AssistantProviderMetadata,
  Message,
  UserMessageContextCompactionMetadata,
} from "../llm/types.ts";
import {
  type ToolCall,
  toolCallCanonicalArguments,
  toolCallFromParsedArguments,
} from "../tools/registry.ts";

const REDACTION_MARKER = "[REDACTED_SECRET]";
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const ENV_SECRET_ASSIGNMENT_PATTERN =
  /(^|[\r\n])([A-Z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD)[A-Z0-9_]*\s*=\s*)([^\r\n#]+)/giu;
const BEARER_TOKEN_PATTERN = /\bBearer[ \t]+[-._~+/=A-Za-z0-9]+/gu;
const OPENAI_STYLE_KEY_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/gu;
const GITHUB_TOKEN_PATTERN =
  /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}_[A-Za-z0-9_]{20,})\b/gu;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{35}\b/gu;
const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;

export function redactTextForPersistence(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTION_MARKER)
    .replace(
      ENV_SECRET_ASSIGNMENT_PATTERN,
      (_match, lineStart: string, keyPrefix: string) =>
        `${lineStart}${keyPrefix}${REDACTION_MARKER}`,
    )
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTION_MARKER}`)
    .replace(OPENAI_STYLE_KEY_PATTERN, REDACTION_MARKER)
    .replace(GITHUB_TOKEN_PATTERN, REDACTION_MARKER)
    .replace(GOOGLE_API_KEY_PATTERN, REDACTION_MARKER)
    .replace(AWS_ACCESS_KEY_ID_PATTERN, REDACTION_MARKER);
}

export function hasPersistenceRedactionMarker(text: string): boolean {
  return text.includes(REDACTION_MARKER);
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

function redactToolCallForPersistence(toolCall: ToolCall): ToolCall {
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
  };
}

export function redactMessageForPersistence(message: Message): Message {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: redactTextForPersistence(message.content),
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
