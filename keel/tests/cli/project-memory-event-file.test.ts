import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  acquireProjectMemoryWriteLock,
  appendProjectMemoryEvent,
  removeProjectMemoryEventFile,
} from "../../src/cli/project-memory-event-file.ts";
import {
  eventTargetsMemory,
  projectMemoryEventSchema,
} from "../../src/cli/project-memory-events.ts";

const CREATED_AT = "2026-07-17T00:00:00.000Z";
const MEMORY_ID = "mem_11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "cand_11111111-1111-4111-8111-111111111111";

function addEvent() {
  return projectMemoryEventSchema.parse({
    version: 4,
    type: "add",
    memory: {
      id: MEMORY_ID,
      text: "Release tags use a v prefix.",
      source: {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory add",
      },
      createdAt: CREATED_AT,
      lastVerifiedAt: CREATED_AT,
      supersedes: [],
      reviewAfter: null,
      expiresAt: null,
    },
  });
}

function successfulExtractionEvent() {
  return projectMemoryEventSchema.parse({
    version: 4,
    type: "candidate_extraction",
    operation: {
      operationId: "mcex_11111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
      trigger: "explicit_command",
      extractorVersion: 1,
      maxCostUsd: 0.05,
      createdAt: CREATED_AT,
      finishedAt: CREATED_AT,
      outcome: "succeeded",
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        uncachedInputTokens: 10,
        outputTokens: 5,
      },
      costUsd: 0.0000028,
      attemptCount: 1,
      retryCount: 0,
      resultCount: 1,
      failure: null,
    },
    candidates: [
      {
        id: CANDIDATE_ID,
        kind: "project_context",
        statement: "Release tags use a v prefix.",
        why: "This convention should remain stable.",
        sources: [
          {
            sessionId: "session-1",
            messageId: "msg_1",
            quote: "Release tags use a v prefix.",
          },
        ],
        duplicateMemoryIds: [],
        conflictMemoryIds: [],
        sensitivityValidation: "passed_sensitive_text_v1",
        createdAt: CREATED_AT,
        expiresAt: "2026-08-16T00:00:00.000Z",
      },
    ],
    purgedCandidateCount: 0,
    discardedCandidateIds: [],
  });
}

describe("project-memory event boundaries", () => {
  test(`Given an event path is a directory and a lock parent is not a directory,
    When file mutation and lease acquisition run,
    Then each unsafe filesystem shape fails closed with a precise boundary error`, async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "keel-memory-event-file-"));
    const unsafePath = join(directory, "events.jsonl");
    await mkdir(unsafePath);
    try {
      // When / Then
      expect(() => appendProjectMemoryEvent(unsafePath, addEvent())).toThrow(
        "unsafe project memory path",
      );
      expect(() => removeProjectMemoryEventFile(unsafePath)).toThrow(
        "unsafe project memory path",
      );

      const notDirectory = join(directory, "not-a-directory");
      await writeFile(notDirectory, "file");
      expect(() => acquireProjectMemoryWriteLock(notDirectory)).toThrow(
        "cannot acquire project memory lock",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`Given extraction events contradict their terminal outcome or result count,
    When the persisted schema validates them,
    Then both cross-field inconsistencies are rejected`, () => {
    // Given
    const succeeded = successfulExtractionEvent();
    if (
      succeeded.type !== "candidate_extraction" ||
      succeeded.operation.outcome !== "succeeded"
    ) {
      throw new Error("expected successful extraction fixture");
    }
    const failedWithCandidate = {
      ...succeeded,
      operation: {
        ...succeeded.operation,
        outcome: "failed",
        resultCount: 0,
        failure: "provider_error",
      },
    };
    const mismatchedCount = {
      ...succeeded,
      operation: { ...succeeded.operation, resultCount: 0 },
    };

    // When / Then
    expect(
      projectMemoryEventSchema.safeParse(failedWithCandidate).success,
    ).toBe(false);
    expect(projectMemoryEventSchema.safeParse(mismatchedCount).success).toBe(
      false,
    );
  });

  test(`Given memory and candidate-only events,
    When relation helpers inspect their targets,
    Then only the event carrying the requested memory reports a match`, () => {
    // Given
    const candidate = successfulExtractionEvent();

    // When / Then
    expect(eventTargetsMemory(addEvent(), MEMORY_ID)).toBe(true);
    expect(eventTargetsMemory(candidate, MEMORY_ID)).toBe(false);
  });
});
