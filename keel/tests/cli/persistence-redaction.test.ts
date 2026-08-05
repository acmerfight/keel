import { describe, expect, test } from "vitest";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import {
  redactMessageForPersistence,
  redactProviderMessageForPersistence,
  redactTextForPersistence,
} from "../../src/cli/persistence-redaction.ts";
import type { ProviderMessage } from "../../src/llm/types.ts";

describe("CLI Persistence Redaction", () => {
  test(`Given a persisted transcript line ends with the word Bearer,
    When redaction scans the provider-visible text,
    Then it preserves the line break and the next benign word`, () => {
    // Given
    const text = "Use the word Bearer\nauthorization is required for access.";

    // When
    const redacted = redactTextForPersistence(text);

    // Then
    expect(redacted).toBe(text);
  });

  test(`Given a persisted transcript contains a bearer token on one line,
    When redaction scans the provider-visible text,
    Then it redacts the token without changing surrounding lines`, () => {
    // Given
    const text = "before\nAuthorization: Bearer live-secret-token-270\nafter";

    // When
    const redacted = redactTextForPersistence(text);

    // Then
    expect(redacted).toBe(
      "before\nAuthorization: Bearer [REDACTED_SECRET]\nafter",
    );
  });

  test(`Given dynamic MCP arguments contain every typed JSON value shape,
    When the assistant message is prepared for persistence,
    Then nested strings are redacted while null and primitive types retain their types`, () => {
    // Given
    const message: SessionMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          kind: "mcp",
          id: "remote_search",
          tool: "mcp__catalog__search",
          reference: {
            kind: "mcp",
            serverId: "catalog",
            serverOrigin: "https://catalog.example",
            rawToolName: "search",
            configurationDigest: "a".repeat(64),
            catalogGeneration: `catalog:${"b".repeat(64)}`,
            descriptorDigest: "c".repeat(64),
          },
          arguments: {
            nullable: null,
            enabled: true,
            count: 2,
            secret: "Authorization: Bearer live-secret-token-270",
            nested: [
              false,
              {
                token: "Authorization: Bearer nested-secret-token-271",
              },
            ],
          },
        },
      ],
    };

    // When
    const redacted = redactMessageForPersistence(message);

    // Then
    expect(redacted).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          kind: "mcp",
          arguments: {
            nullable: null,
            enabled: true,
            count: 2,
            secret: "Authorization: Bearer [REDACTED_SECRET]",
            nested: [
              false,
              { token: "Authorization: Bearer [REDACTED_SECRET]" },
            ],
          },
        },
      ],
    });
  });

  test(`Given provider replay metadata contains secret-like reasoning text,
    When the provider message is prepared for a transcript,
    Then the metadata is retained with its secret redacted`, () => {
    // Given
    const message: ProviderMessage = {
      role: "assistant",
      content: "done",
      toolCalls: [],
      providerMetadata: {
        openaiCompatible: {
          reasoningContent:
            "Authorization: Bearer provider-reasoning-secret-272",
        },
      },
    };

    // When
    const redacted = redactProviderMessageForPersistence(message);

    // Then
    expect(redacted).toEqual({
      role: "assistant",
      content: "done",
      toolCalls: [],
      providerMetadata: {
        openaiCompatible: {
          reasoningContent: "Authorization: Bearer [REDACTED_SECRET]",
        },
      },
    });
  });
});
