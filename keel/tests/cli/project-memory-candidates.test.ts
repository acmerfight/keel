import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  addProjectMemory,
  forgetProjectMemory,
  listProjectMemory,
  purgeAllProjectMemory,
  purgeProjectMemory,
} from "../../src/cli/project-memory.ts";
import {
  approveProjectMemoryCandidate,
  type CandidateExtractionRecord,
  type CandidateProposal,
  clearProjectMemoryCandidates,
  editProjectMemoryCandidate,
  listProjectMemoryCandidates,
  purgeProjectMemoryCandidate,
  recordCandidateExtraction,
  rejectProjectMemoryCandidate,
  showProjectMemoryCandidate,
} from "../../src/cli/project-memory-candidates.ts";
import { projectMemoryEventSchema } from "../../src/cli/project-memory-events.ts";
import { projectMemoryReportEntry } from "../../src/cli/report.ts";
import { createGitWorkspace } from "../../src/testing/cli-harness.ts";

const CREATED_AT = "2026-07-17T00:00:00.000Z";

function storeRuntime(keelHome: string, now: () => number) {
  return {
    env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
    now,
  };
}

function extraction(
  sessionId: string,
  operationId: string,
): CandidateExtractionRecord {
  return {
    operationId,
    sessionId,
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      uncachedInputTokens: 100,
      outputTokens: 20,
    },
    costUsd: 0.0000196,
    attemptCount: 1,
    retryCount: 0,
    maxCostUsd: 0.05,
    createdAt: CREATED_AT,
    finishedAt: CREATED_AT,
  };
}

function proposal(sessionId: string, statement: string): CandidateProposal {
  return {
    kind: "project_context",
    statement,
    why: "Future work must preserve this user-supplied project invariant.",
    sources: [
      {
        sessionId,
        messageId: "msg_1",
        quote: statement,
      },
    ],
    conflictMemoryIds: [],
  };
}

describe("project-memory candidate store", () => {
  test(`Given a new extracted candidate,
    When the user edits, rejects, and physically purges it,
    Then every lifecycle transition is deterministic and no candidate payload remains`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-lifecycle-");
    const keelHome = await mkdtemp(join(tmpdir(), "keel-candidate-home-"));
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    const original = "The release owner is the platform team.";
    const replacement = "The platform team owns release validation.";
    try {
      const recorded = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(
          "lifecycle-session",
          "mcex_11111111-1111-4111-8111-111111111111",
        ),
        [proposal("lifecycle-session", original)],
        false,
      );
      const candidateId = recorded.candidates[0]?.id;
      expect(candidateId).toBeDefined();
      expect(
        listProjectMemory(runtime, workspace, { all: false }).entries,
      ).toEqual([]);

      // When
      const edited = editProjectMemoryCandidate(
        runtime,
        workspace,
        String(candidateId),
        replacement,
      );
      rejectProjectMemoryCandidate(runtime, workspace, String(candidateId));

      // Then
      expect(edited.originalStatement).toBe(original);
      expect(edited.statement).toBe(replacement);
      expect(
        listProjectMemoryCandidates(runtime, workspace).candidates[0]?.status,
      ).toBe("rejected");

      purgeProjectMemoryCandidate(
        runtime,
        workspace,
        String(candidateId),
        null,
      );
      const afterPurge = listProjectMemoryCandidates(runtime, workspace);
      expect(afterPurge.candidates).toEqual([]);
      expect(afterPurge.operations).toHaveLength(1);
      expect(afterPurge.operations[0]).toMatchObject({
        outcome: "succeeded",
        resultCount: 1,
      });
      const eventsPath = join(
        keelHome,
        "memory",
        "projects",
        recorded.scope.id,
        "events.jsonl",
      );
      const events = await readFile(eventsPath, "utf8");
      expect(events).not.toContain(original);
      expect(events).not.toContain(replacement);
      expect(events).not.toContain(String(candidateId));
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given one session already has a successful extraction,
    When extraction repeats without and then with explicit retry,
    Then only the explicit retry runs and it discards the older pending candidate`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-retry-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-retry-home-"),
    );
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    const sessionId = "retry-session";
    try {
      const first = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(sessionId, "mcex_22222222-2222-4222-8222-222222222222"),
        [proposal(sessionId, "Use invoice IDs as the audit-system key.")],
        false,
      );

      // When / Then
      expect(() =>
        recordCandidateExtraction(
          runtime,
          workspace,
          extraction(sessionId, "mcex_33333333-3333-4333-8333-333333333333"),
          [],
          false,
        ),
      ).toThrow("already has a successful candidate extraction");

      const retried = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(sessionId, "mcex_44444444-4444-4444-8444-444444444444"),
        [proposal(sessionId, "Preserve invoice IDs for external audits.")],
        true,
      );
      const listed = listProjectMemoryCandidates(runtime, workspace).candidates;
      expect(
        listed.find((candidate) => candidate.id === first.candidates[0]?.id)
          ?.status,
      ).toBe("discarded");
      expect(
        listed.find((candidate) => candidate.id === retried.candidates[0]?.id)
          ?.status,
      ).toBe("pending");
      purgeProjectMemoryCandidate(
        runtime,
        workspace,
        String(first.candidates[0]?.id),
        null,
      );
      expect(
        listProjectMemoryCandidates(runtime, workspace).candidates.some(
          (candidate) => candidate.id === first.candidates[0]?.id,
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given a candidate names an active-memory conflict,
    When the user explicitly supersedes it and later purges that active memory,
    Then approval records the relation and the governed purge removes every linked candidate copy`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-conflict-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-conflict-home-"),
    );
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    const active = addProjectMemory(
      runtime,
      workspace,
      "The platform team owns releases.",
      {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory add",
      },
      { reviewAfter: null, expiresAt: null },
    );
    const sessionId = "conflict-session";
    const statement = "The reliability team owns releases.";
    try {
      const recorded = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(sessionId, "mcex_55555555-5555-4555-8555-555555555555"),
        [
          {
            ...proposal(sessionId, statement),
            conflictMemoryIds: [active.entry.id],
          },
        ],
        false,
      );
      const candidateId = String(recorded.candidates[0]?.id);

      // When / Then
      expect(() =>
        approveProjectMemoryCandidate(runtime, workspace, candidateId, {
          type: "none",
        }),
      ).toThrow("Approve with --keep or --supersede");

      const approved = approveProjectMemoryCandidate(
        runtime,
        workspace,
        candidateId,
        { type: "supersede", memoryId: active.entry.id },
      );
      expect(approved.memory.supersedes).toEqual([active.entry.id]);
      expect(approved.memory.source).toEqual({
        type: "user_approved",
        channel: "cli",
        evidence: `approved candidate ${candidateId} from session ${sessionId}`,
        candidateId,
      });

      purgeProjectMemory(runtime, workspace, approved.memory.id, {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory purge",
      });
      expect(
        listProjectMemoryCandidates(runtime, workspace).candidates,
      ).toEqual([]);
      expect(
        listProjectMemory(runtime, workspace, { all: true }).entries.some(
          (entry) => entry.id === approved.memory.id,
        ),
      ).toBe(false);
      const events = await readFile(
        join(keelHome, "memory", "projects", approved.scope.id, "events.jsonl"),
        "utf8",
      );
      expect(events).not.toContain(statement);
      expect(events).not.toContain(candidateId);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given active memory already contains the same claim and another project has its own inbox,
    When extraction records the duplicate in the first project,
    Then the duplicate is visible, cannot be approved, and never leaks across project scope`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-duplicate-");
    const otherWorkspace = await createGitWorkspace(
      "keel-candidate-other-project-",
    );
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-duplicate-home-"),
    );
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    const statement = "Release tags use a v prefix.";
    try {
      const active = addProjectMemory(
        runtime,
        workspace,
        statement,
        {
          type: "user_explicit",
          channel: "cli",
          evidence: "memory add",
        },
        { reviewAfter: null, expiresAt: null },
      );
      const recorded = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(
          "duplicate-session",
          "mcex_99999999-9999-4999-8999-999999999999",
        ),
        [proposal("duplicate-session", statement)],
        false,
      );
      const candidate = recorded.candidates[0];
      expect(candidate).toBeDefined();

      // When / Then
      expect(candidate?.duplicateMemoryIds).toEqual([active.entry.id]);
      expect(() =>
        approveProjectMemoryCandidate(
          runtime,
          workspace,
          String(candidate?.id),
          { type: "none" },
        ),
      ).toThrow(`duplicates active memory ${active.entry.id}`);
      expect(
        listProjectMemoryCandidates(runtime, otherWorkspace).candidates,
      ).toEqual([]);
      expect(
        listProjectMemory(runtime, otherWorkspace, { all: true }).entries,
      ).toEqual([]);
      expect(
        clearProjectMemoryCandidates(runtime, otherWorkspace, true, true),
      ).toMatchObject({ cleared: 0, purgedMemoryCount: 0 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(otherWorkspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given the user edits a candidate after model conflict analysis,
    When approval runs against current active memory,
    Then stale conflict metadata cannot authorize activation without an explicit keep or supersede decision`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-candidate-edited-conflict-",
    );
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-edited-conflict-home-"),
    );
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    try {
      const active = addProjectMemory(
        runtime,
        workspace,
        "The platform team owns releases.",
        { type: "user_explicit", channel: "cli", evidence: "memory add" },
        { reviewAfter: null, expiresAt: null },
      );
      const candidate = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(
          "edited-conflict",
          "mcex_5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        [proposal("edited-conflict", "Use signed release tags.")],
        false,
      ).candidates[0];
      editProjectMemoryCandidate(
        runtime,
        workspace,
        String(candidate?.id),
        "The reliability team owns releases.",
      );

      // When / Then
      expect(() =>
        approveProjectMemoryCandidate(
          runtime,
          workspace,
          String(candidate?.id),
          { type: "none" },
        ),
      ).toThrow("edited candidate requires an explicit conflict decision");
      const approved = approveProjectMemoryCandidate(
        runtime,
        workspace,
        String(candidate?.id),
        { type: "supersede", memoryId: active.entry.id },
      );
      expect(approved.memory.supersedes).toEqual([active.entry.id]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given pending, rejected, expired, and approved candidates share one project store,
    When the user requests physical clear,
    Then linked active memory requires explicit consent and the accepted clear removes the whole candidate generation`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-clear-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-clear-home-"),
    );
    let now = Date.parse(CREATED_AT);
    const runtime = storeRuntime(keelHome, () => now);
    try {
      const unrelated = addProjectMemory(
        runtime,
        workspace,
        "Keep the release handbook current.",
        { type: "user_explicit", channel: "cli", evidence: "memory add" },
        { reviewAfter: null, expiresAt: null },
      );
      const first = recordCandidateExtraction(
        runtime,
        workspace,
        extraction("clear-1", "mcex_66666666-6666-4666-8666-666666666666"),
        [proposal("clear-1", "Keep canary releases enabled.")],
        false,
      ).candidates[0];
      const second = recordCandidateExtraction(
        runtime,
        workspace,
        extraction("clear-2", "mcex_77777777-7777-4777-8777-777777777777"),
        [proposal("clear-2", "Review ownership quarterly.")],
        false,
      ).candidates[0];
      rejectProjectMemoryCandidate(runtime, workspace, String(second?.id));
      editProjectMemoryCandidate(
        runtime,
        workspace,
        String(first?.id),
        "Keep canary releases enabled for production.",
      );
      const approved = approveProjectMemoryCandidate(
        runtime,
        workspace,
        String(first?.id),
        { type: "keep" },
      );
      const fourth = recordCandidateExtraction(
        runtime,
        workspace,
        extraction("clear-4", "mcex_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        [proposal("clear-4", "Keep rollback validation enabled.")],
        false,
      ).candidates[0];
      const secondApproved = approveProjectMemoryCandidate(
        runtime,
        workspace,
        String(fourth?.id),
        { type: "none" },
      );
      recordCandidateExtraction(
        runtime,
        workspace,
        extraction("clear-3", "mcex_88888888-8888-4888-8888-888888888888"),
        [proposal("clear-3", "This candidate will expire.")],
        false,
      );
      now += 31 * 24 * 60 * 60 * 1_000;
      expect(
        listProjectMemoryCandidates(runtime, workspace).candidates.some(
          (candidate) => candidate.status === "expired",
        ),
      ).toBe(true);

      // When / Then
      expect(() =>
        clearProjectMemoryCandidates(runtime, workspace, true, false),
      ).toThrow("Purge both explicitly with --purge-memories");

      const cleared = clearProjectMemoryCandidates(
        runtime,
        workspace,
        true,
        true,
      );
      expect(cleared).toMatchObject({
        cleared: 4,
        purgedMemoryCount: 2,
      });
      const afterClear = listProjectMemoryCandidates(runtime, workspace);
      expect(afterClear.candidates).toEqual([]);
      expect(afterClear.operations).toHaveLength(4);
      expect(
        listProjectMemory(runtime, workspace, { all: true }).entries.some(
          (entry) =>
            entry.id === approved.memory.id ||
            entry.id === secondApproved.memory.id,
        ),
      ).toBe(false);
      expect(
        listProjectMemory(runtime, workspace, { all: false }).entries.map(
          (entry) => entry.id,
        ),
      ).toEqual([unrelated.entry.id]);
      await expect(
        access(
          join(
            keelHome,
            "memory",
            "projects",
            approved.scope.id,
            "events.jsonl",
          ),
        ),
      ).resolves.toBeUndefined();
      const events = await readFile(
        join(keelHome, "memory", "projects", approved.scope.id, "events.jsonl"),
        "utf8",
      );
      expect(events).not.toContain("canary releases");
      expect(events).not.toContain("Review ownership quarterly");
      expect(events).not.toContain("This candidate will expire");
      expect(events).not.toContain("rollback validation");
      expect(events).toContain('"outcome":"succeeded"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given malformed proposals and invalid lifecycle requests reach the candidate store,
    When deterministic validation runs,
    Then the store rejects each request before appending an ambiguous event`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-validation-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-validation-home-"),
    );
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    const sessionId = "validation-session";
    try {
      const active = addProjectMemory(
        runtime,
        workspace,
        "The platform team owns release validation.",
        { type: "user_explicit", channel: "cli", evidence: "memory add" },
        { reviewAfter: null, expiresAt: null },
      );
      expect(() =>
        recordCandidateExtraction(
          runtime,
          workspace,
          extraction(sessionId, "mcex_a1111111-1111-4111-8111-111111111111"),
          Array.from({ length: 6 }, (_, index) =>
            proposal(sessionId, `Candidate ${index}`),
          ),
          false,
        ),
      ).toThrow("more than 5 candidates");
      expect(() =>
        recordCandidateExtraction(
          runtime,
          workspace,
          extraction(sessionId, "mcex_a2222222-2222-4222-8222-222222222222"),
          [proposal("different-session", "Keep release notes concise.")],
          false,
        ),
      ).toThrow("source session does not match");
      expect(() =>
        recordCandidateExtraction(
          runtime,
          workspace,
          extraction(sessionId, "mcex_a3333333-3333-4333-8333-333333333333"),
          [
            {
              ...proposal(sessionId, "Keep release notes concise."),
              conflictMemoryIds: ["mem_00000000-0000-4000-8000-000000000000"],
            },
          ],
          false,
        ),
      ).toThrow("is not active in this project");
      expect(() =>
        recordCandidateExtraction(
          runtime,
          workspace,
          extraction(sessionId, "mcex_a4444444-4444-4444-8444-444444444444"),
          [{ ...proposal(sessionId, "valid"), statement: "   " }],
          false,
        ),
      ).toThrow("non-empty statement");
      expect(() =>
        recordCandidateExtraction(
          runtime,
          workspace,
          extraction(sessionId, "mcex_a5555555-5555-4555-8555-555555555555"),
          [{ ...proposal(sessionId, "valid"), why: "owner@example.com" }],
          false,
        ),
      ).toThrow("prohibited sensitive data");

      const candidate = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(sessionId, "mcex_a6666666-6666-4666-8666-666666666666"),
        [
          {
            ...proposal(sessionId, "The reliability team owns validation."),
            conflictMemoryIds: [active.entry.id, active.entry.id],
          },
        ],
        false,
      ).candidates[0];
      expect(candidate?.conflictMemoryIds).toEqual([active.entry.id]);
      forgetProjectMemory(runtime, workspace, active.entry.id, {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory forget",
      });

      // When / Then
      expect(() =>
        showProjectMemoryCandidate(runtime, workspace, "not-an-id"),
      ).toThrow("invalid project-memory candidate id");
      expect(() =>
        editProjectMemoryCandidate(
          runtime,
          workspace,
          String(candidate?.id),
          "",
        ),
      ).toThrow("non-empty statement");
      expect(() =>
        editProjectMemoryCandidate(
          runtime,
          workspace,
          String(candidate?.id),
          String(candidate?.statement),
        ),
      ).toThrow("must change");
      expect(() =>
        purgeProjectMemoryCandidate(
          runtime,
          workspace,
          String(candidate?.id),
          active.entry.id,
        ),
      ).toThrow("has no linked active memory");
      expect(() =>
        approveProjectMemoryCandidate(
          runtime,
          workspace,
          String(candidate?.id),
          {
            type: "supersede",
            memoryId: "mem_00000000-0000-4000-8000-000000000000",
          },
        ),
      ).toThrow("is not a current conflict");
      const approved = approveProjectMemoryCandidate(
        runtime,
        workspace,
        String(candidate?.id),
        { type: "keep" },
      );
      expect(approved.memory.supersedes).toEqual([]);
      expect(
        projectMemoryReportEntry({
          id: approved.memory.id,
          text: approved.memory.text,
          status: "current",
          source: {
            type: "user_approved",
            channel: "cli",
            evidence: approved.memory.source.evidence,
            candidateId: String(candidate?.id),
          },
          createdAt: approved.memory.createdAt,
          lastVerifiedAt: approved.memory.lastVerifiedAt,
          supersedes: approved.memory.supersedes,
          supersededBy: null,
          reviewAfter: approved.memory.reviewAfter,
          expiresAt: approved.memory.expiresAt,
        }).source,
      ).toEqual({
        type: "user_approved",
        channel: "cli",
        candidateId: candidate?.id,
      });
      expect(() =>
        editProjectMemoryCandidate(
          runtime,
          workspace,
          String(candidate?.id),
          "A different statement.",
        ),
      ).toThrow("approved, not pending");
      expect(() =>
        rejectProjectMemoryCandidate(runtime, workspace, String(candidate?.id)),
      ).toThrow("approved, not pending");
      expect(() =>
        approveProjectMemoryCandidate(
          runtime,
          workspace,
          String(candidate?.id),
          {
            type: "none",
          },
        ),
      ).toThrow("approved, not pending");
      expect(
        clearProjectMemoryCandidates(runtime, workspace, false, false),
      ).toMatchObject({
        cleared: 0,
        purgedMemoryCount: 0,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given the bounded inbox already contains one hundred pending candidates,
    When another extraction would add a candidate,
    Then it is rejected without changing the existing inbox`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-cap-");
    const keelHome = await mkdtemp(join(tmpdir(), "keel-candidate-cap-home-"));
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    try {
      for (let batch = 0; batch < 20; batch += 1) {
        const sessionId = `cap-${batch}`;
        recordCandidateExtraction(
          runtime,
          workspace,
          extraction(
            sessionId,
            `mcex_${String(batch).padStart(8, "0")}-0000-4000-8000-000000000000`,
          ),
          Array.from({ length: 5 }, (_, index) =>
            proposal(sessionId, `Durable bounded fact ${batch}-${index}.`),
          ),
          false,
        );
      }
      expect(
        listProjectMemoryCandidates(runtime, workspace).candidates,
      ).toHaveLength(100);

      // When / Then
      expect(() =>
        recordCandidateExtraction(
          runtime,
          workspace,
          extraction(
            "cap-overflow",
            "mcex_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          ),
          [proposal("cap-overflow", "One candidate too many.")],
          false,
        ),
      ).toThrow("would exceed 100 pending candidates");
      expect(
        listProjectMemoryCandidates(runtime, workspace).candidates,
      ).toHaveLength(100);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given schema-valid but relationally corrupt candidate events are found on disk,
    When the candidate projection replays them,
    Then every invalid target, duplicate, source, and activation relation fails closed`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-corruption-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-corruption-home-"),
    );
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    try {
      const recorded = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(
          "corrupt-session",
          "mcex_e1111111-1111-4111-8111-111111111111",
        ),
        [proposal("corrupt-session", "Keep canary validation enabled.")],
        false,
      );
      const filePath = join(
        keelHome,
        "memory",
        "projects",
        recorded.scope.id,
        "events.jsonl",
      );
      const original = await readFile(filePath, "utf8");
      const seed = projectMemoryEventSchema.parse(
        JSON.parse(original.trimEnd()),
      );
      if (
        seed.type !== "candidate_extraction" ||
        seed.operation.outcome !== "succeeded"
      ) {
        throw new Error("expected candidate extraction seed");
      }
      const candidate = seed.candidates[0];
      if (candidate === undefined) throw new Error("expected candidate seed");
      const unknownCandidate = "cand_00000000-0000-4000-8000-000000000000";
      const cases = [
        [
          projectMemoryEventSchema.parse({
            ...seed,
            operation: {
              ...seed.operation,
              operationId: "mcex_e2222222-2222-4222-8222-222222222222",
              resultCount: 0,
            },
            candidates: [],
            discardedCandidateIds: [unknownCandidate],
          }),
          "extraction discards invalid",
        ],
        [
          projectMemoryEventSchema.parse({
            ...seed,
            operation: {
              ...seed.operation,
              operationId: "mcex_e3333333-3333-4333-8333-333333333333",
            },
          }),
          "duplicate candidate",
        ],
        [
          projectMemoryEventSchema.parse({
            ...seed,
            operation: {
              ...seed.operation,
              operationId: "mcex_e4444444-4444-4444-8444-444444444444",
              sessionId: "different-session",
            },
            candidates: [
              {
                ...candidate,
                id: "cand_11111111-1111-4111-8111-111111111111",
              },
            ],
          }),
          "candidate source session mismatch",
        ],
        [
          projectMemoryEventSchema.parse({
            version: 4,
            type: "candidate_edit",
            targetId: unknownCandidate,
            statement: "Unknown edit.",
            createdAt: CREATED_AT,
          }),
          "edit targets invalid",
        ],
        [
          projectMemoryEventSchema.parse({
            version: 4,
            type: "candidate_reject",
            targetIds: [unknownCandidate],
            reason: "user_rejected",
            createdAt: CREATED_AT,
          }),
          "reject targets invalid",
        ],
        [
          projectMemoryEventSchema.parse({
            version: 4,
            type: "candidate_approve",
            targetId: unknownCandidate,
            memory: {
              id: "mem_22222222-2222-4222-8222-222222222222",
              text: "Unknown activation.",
              source: {
                type: "user_approved",
                channel: "cli",
                evidence: "corrupt activation",
                candidateId: unknownCandidate,
              },
              createdAt: CREATED_AT,
              lastVerifiedAt: CREATED_AT,
              supersedes: [],
              reviewAfter: null,
              expiresAt: null,
            },
          }),
          "approve targets invalid",
        ],
        [
          projectMemoryEventSchema.parse({
            version: 4,
            type: "candidate_approve",
            targetId: candidate.id,
            memory: {
              id: "mem_33333333-3333-4333-8333-333333333333",
              text: "Different activation text.",
              source: {
                type: "user_approved",
                channel: "cli",
                evidence: "corrupt activation",
                candidateId: candidate.id,
              },
              createdAt: CREATED_AT,
              lastVerifiedAt: CREATED_AT,
              supersedes: [],
              reviewAfter: null,
              expiresAt: null,
            },
          }),
          "invalid activation relation",
        ],
      ] as const;

      // When / Then
      for (const [event, message] of cases) {
        await writeFile(filePath, `${original}${JSON.stringify(event)}\n`);
        expect(() => listProjectMemoryCandidates(runtime, workspace)).toThrow(
          message,
        );
      }
      await writeFile(filePath, original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given direct memory, approved candidate memory, and an unrelated pending candidate coexist,
    When all active project memory is physically purged,
    Then linked candidate artifacts leave with active memory while the unrelated inbox item remains`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-purge-all-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-purge-all-home-"),
    );
    const runtime = storeRuntime(keelHome, () => Date.parse(CREATED_AT));
    try {
      addProjectMemory(
        runtime,
        workspace,
        "The handbook is the release source of truth.",
        { type: "user_explicit", channel: "cli", evidence: "memory add" },
        { reviewAfter: null, expiresAt: null },
      );
      const approvedCandidate = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(
          "purge-all-approved",
          "mcex_f1111111-1111-4111-8111-111111111111",
        ),
        [proposal("purge-all-approved", "Keep canary releases enabled.")],
        false,
      ).candidates[0];
      approveProjectMemoryCandidate(
        runtime,
        workspace,
        String(approvedCandidate?.id),
        { type: "none" },
      );
      const pending = recordCandidateExtraction(
        runtime,
        workspace,
        extraction(
          "purge-all-pending",
          "mcex_f2222222-2222-4222-8222-222222222222",
        ),
        [proposal("purge-all-pending", "Review release ownership quarterly.")],
        false,
      ).candidates[0];

      // When
      const purged = purgeAllProjectMemory(runtime, workspace);

      // Then
      expect(purged.purged).toBe(2);
      expect(
        listProjectMemory(runtime, workspace, { all: true }).entries,
      ).toEqual([]);
      expect(
        listProjectMemoryCandidates(runtime, workspace).candidates.map(
          (candidate) => candidate.id,
        ),
      ).toEqual([pending?.id]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });
});
