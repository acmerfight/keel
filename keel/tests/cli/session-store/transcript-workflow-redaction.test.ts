import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  forkSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import type { Message } from "../../../src/llm/types.ts";
import type { BashApprovalGrant } from "../../../src/permissions/bash.ts";
import {
  rootGraph,
  runtime,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Transcript Workflow Redaction", () => {
  test(`Given a completed interactive transcript was persisted,
    When the session is resumed,
    Then the provider-visible messages are restored`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "Remembered alpha.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "demo",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "demo",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.messages).toEqual(messages);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a checkpoint carries source-backed evidence metadata,
    When the session is persisted and resumed,
    Then the evidence metadata is restored with at-rest redaction applied`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "user",
        content: "checkpoint with evidence metadata",
        contextCompaction: {
          evidence: [
            {
              handle: "read:sk-secret-329.txt",
              label: "read sk-secret-329",
              source: "complete",
              why: "Bearer live-secret-329-token appeared in the evidence",
            },
            {
              handle: "tool-output:scope/report",
              label: "bash report",
              source: "complete",
              inspectCommand:
                "keel artifacts show tool-output:scope/sk-secret-330",
              why: "prior artifact evidence",
            },
          ],
        },
      },
      { role: "assistant", content: "Ready to continue.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "checkpoint-evidence-metadata",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      const ledger = await readFile(session.filePath, "utf8");
      const resumed = resumeSessionStore({
        sessionId: "checkpoint-evidence-metadata",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(ledger).not.toContain("sk-secret-329");
      expect(ledger).not.toContain("sk-secret-330");
      expect(ledger).not.toContain("live-secret-329-token");
      expect(resumed.messages[0]).toEqual({
        role: "user",
        content: "checkpoint with evidence metadata",
        contextCompaction: {
          evidence: [
            {
              handle: "read:[REDACTED_SECRET].txt",
              label: "read [REDACTED_SECRET]",
              source: "complete",
              why: "Bearer [REDACTED_SECRET] appeared in the evidence",
            },
            {
              handle: "tool-output:scope/report",
              label: "bash report",
              source: "complete",
              inspectCommand:
                "keel artifacts show tool-output:scope/[REDACTED_SECRET]",
              why: "prior artifact evidence",
            },
          ],
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session starts with a workflow skill,
    When the session is resumed and forked,
    Then the selected workflow skill is restored with the session context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const workflowSkill = {
      id: "repo:test:review",
      packageId: "repo:test:review",
      digest: "digest",
      qualifiedName: "repo:review",
      scope: "repo" as const,
      name: "review",
      relativePath: ".agents/skills/review/SKILL.md",
      resourcePaths: ["references/checklist.md"],
      content: "Read PR comments first.",
    };

    try {
      createSessionStore({
        sessionId: "skilled",
        workspace,
        runtime: runtime(home),
        workflowSkill,
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "skilled",
        workspace,
        runtime: runtime(home, 1),
      });
      const forked = forkSessionStore({
        source: resumed,
        targetSessionId: "skilled-fork",
        runtime: runtime(home, 2),
      });
      const resumedFork = resumeSessionStore({
        sessionId: "skilled-fork",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.workflowSkill).toEqual(workflowSkill);
      expect(forked.workflowSkill).toEqual(workflowSkill);
      expect(resumedFork.workflowSkill).toEqual(workflowSkill);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a workflow skill contains secret-like provider-visible text,
    When the named session is persisted and resumed,
    Then the ledger stores redacted workflow skill content at rest`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const workflowSkill = {
      id: "repo:test:review",
      packageId: "repo:test:review",
      digest: "digest",
      qualifiedName: "repo:review",
      scope: "repo" as const,
      name: "review",
      relativePath: ".agents/skills/review/SKILL.md",
      resourcePaths: [
        "references/sk-secret-213.md",
        "scripts/sk-secret-214.ts",
      ],
      content:
        "Use API_KEY=sk-secret-213 and Bearer live-secret-213-token during review.",
    };

    try {
      const session = createSessionStore({
        sessionId: "redacted-skill",
        workspace,
        runtime: runtime(home),
        workflowSkill,
      });

      // When
      const ledger = await readFile(session.filePath, "utf8");
      const resumed = resumeSessionStore({
        sessionId: "redacted-skill",
        workspace,
        runtime: runtime(home, 1),
      });

      // Then
      expect(session.workflowSkill?.content).toContain("sk-secret-213");
      expect(ledger).not.toContain("sk-secret-213");
      expect(ledger).not.toContain("live-secret-213-token");
      expect(ledger).toContain("[REDACTED_SECRET]");
      expect(resumed.workflowSkill?.content).toContain("[REDACTED_SECRET]");
      expect(resumed.workflowSkill?.resourcePaths).toContain(
        "references/[REDACTED_SECRET].md",
      );
      expect(resumed.workflowSkill?.resourcePaths).toContain(
        "scripts/[REDACTED_SECRET].ts",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a workflow skill would make the session header exceed the bounded header reader,
    When the named session is created,
    Then the session store rejects the oversized header before writing it`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const workflowSkill = {
      id: "repo:test:review",
      packageId: "repo:test:review",
      digest: "digest",
      qualifiedName: "repo:review",
      scope: "repo" as const,
      name: "review",
      relativePath: ".agents/skills/review/SKILL.md",
      resourcePaths: [],
      content: '"'.repeat(70 * 1024),
    };

    try {
      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "oversized-skill-header",
          workspace,
          runtime: runtime(home),
          workflowSkill,
        }),
      ).toThrow(SessionStoreError);
      expect(() =>
        createSessionStore({
          sessionId: "oversized-skill-header",
          workspace,
          runtime: runtime(home),
          workflowSkill,
        }),
      ).toThrow("session header is too large");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted workflow skill resource path escapes the skill resource directories,
    When the session is resumed,
    Then the session store rejects the invalid header before restoring context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "invalid-skill-resource-path",
        workspace,
        runtime: runtime(home),
      });
      await writeFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 3,
          type: "session",
          id: session.id,
          createdAt: "1970-01-01T00:00:00.000Z",
          workspace: session.workspace,
          graph: rootGraph(session.id),
          workflowSkill: {
            id: "repo:test:review",
            packageId: "repo:test:review",
            digest: "digest",
            qualifiedName: "repo:review",
            scope: "repo",
            name: "review",
            relativePath: ".agents/skills/review/SKILL.md",
            resourcePaths: ["../secret.md"],
            content: "Review workflow body.",
          },
        })}\n`,
        "utf8",
      );

      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "invalid-skill-resource-path",
          workspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
      expect(() =>
        resumeSessionStore({
          sessionId: "invalid-skill-resource-path",
          workspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow("line 1 is not a valid session header");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given session persistence captures secret-like provider-visible messages,
    When the ledger and bounded snapshot are written,
    Then persisted records store redacted markers instead of the raw secret`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const largeMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(16 * 1024 * 1024) },
    ];
    const githubToken = `ghp_${"A".repeat(36)}`;
    const googleApiKey = `AIza${"B".repeat(35)}`;
    const reasoningSecret = "sk-reasoning-secret-213";
    const secretMessages: readonly Message[] = [
      {
        role: "user",
        content: `inspect API_KEY=sk-secret-213 and ${googleApiKey}`,
      },
      {
        role: "assistant",
        content: "Reading with Bearer live-secret-213-token.",
        providerMetadata: {
          openaiCompatible: {
            reasoningContent: `Need to inspect ${reasoningSecret}.`,
          },
        },
        toolCalls: [
          {
            id: "read_secret",
            tool: "read",
            path: "secret.txt",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_secret",
        content: `before sk-secret-213 after ${githubToken}\nAPI_KEY=env-secret-213\n`,
        sourceTruncated: true,
      },
      {
        role: "assistant",
        content: "Inspected secret.txt.",
        toolCalls: [],
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "redacted-snapshot",
        workspace,
        runtime: runtime(home),
      });
      const persistedLargeMessages = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: largeMessages,
        runtime: runtime(home, 1),
        reason: "turn",
      });

      // When
      const persistedSecretMessages = persistSessionMessages({
        session,
        previousMessages: persistedLargeMessages,
        currentMessages: secretMessages,
        runtime: runtime(home, 2),
        reason: "compaction",
      });
      const resumed = resumeSessionStore({
        sessionId: "redacted-snapshot",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(persistedSecretMessages).toEqual(secretMessages);
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger.includes("sk-secret-213")).toBe(false);
      expect(ledger.includes("env-secret-213")).toBe(false);
      expect(ledger.includes("live-secret-213-token")).toBe(false);
      expect(ledger.includes(reasoningSecret)).toBe(false);
      expect(ledger.includes(githubToken)).toBe(false);
      expect(ledger.includes(googleApiKey)).toBe(false);
      expect(ledger.includes("[REDACTED_SECRET]")).toBe(true);

      const ledgerLines = ledger.trimEnd().split("\n");
      const lastLine = ledgerLines.at(-1);
      expect(lastLine).toBeDefined();
      if (lastLine === undefined) {
        throw new Error("Expected snapshot line");
      }
      const snapshot = JSON.parse(lastLine);
      expect(snapshot).toMatchObject({
        type: "snapshot",
        messages: expect.any(Array),
      });
      expect(JSON.stringify(snapshot).includes("sk-secret-213")).toBe(false);
      expect(JSON.stringify(snapshot).includes("env-secret-213")).toBe(false);
      expect(JSON.stringify(snapshot).includes(reasoningSecret)).toBe(false);
      expect(JSON.stringify(snapshot).includes(githubToken)).toBe(false);
      expect(JSON.stringify(snapshot).includes(googleApiKey)).toBe(false);
      expect(JSON.stringify(snapshot).includes("[REDACTED_SECRET]")).toBe(true);
      expect(JSON.stringify(resumed.messages).includes("sk-secret-213")).toBe(
        false,
      );
      expect(JSON.stringify(resumed.messages).includes("env-secret-213")).toBe(
        false,
      );
      expect(JSON.stringify(resumed.messages).includes(reasoningSecret)).toBe(
        false,
      );
      expect(JSON.stringify(resumed.messages).includes(githubToken)).toBe(
        false,
      );
      expect(JSON.stringify(resumed.messages).includes(googleApiKey)).toBe(
        false,
      );
      expect(
        JSON.stringify(resumed.messages).includes("[REDACTED_SECRET]"),
      ).toBe(true);
      const resumedToolMessage = resumed.messages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" && message.toolCallId === "read_secret",
      );
      expect(resumedToolMessage?.sourceTruncated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given queued input and bash approval contain secret-like values,
    When the ledger and bounded snapshot are written,
    Then persisted session metadata stores redacted markers instead of raw secrets`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const largeMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(16 * 1024 * 1024) },
    ];
    const grant = {
      type: "exact",
      cwd: ledgerWorkspace,
      command: "printf 'Bearer live-secret-approval-token'",
    } satisfies BashApprovalGrant;

    try {
      const session = createSessionStore({
        sessionId: "redacted-session-metadata",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 4,
        line: "continue with sk-secret-queued-214",
        runtime: runtime(home, 1),
      });
      persistSessionBashApprovalGrant({
        session,
        grant,
        runtime: runtime(home, 2),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: largeMessages,
        runtime: runtime(home, 3),
        reason: "turn",
      });
      const resumed = resumeSessionStore({
        sessionId: "redacted-session-metadata",
        workspace,
        runtime: runtime(home, 4),
      });

      // Then
      expect(queuedInput.line).toBe("continue with sk-secret-queued-214");

      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger.includes("sk-secret-queued-214")).toBe(false);
      expect(ledger.includes("live-secret-approval-token")).toBe(false);
      expect(ledger.includes("[REDACTED_SECRET]")).toBe(true);

      const lastLine = ledger.trimEnd().split("\n").at(-1);
      expect(lastLine).toBeDefined();
      if (lastLine === undefined) {
        throw new Error("Expected snapshot line");
      }
      const snapshot = JSON.parse(lastLine);
      expect(snapshot).toMatchObject({
        type: "snapshot",
        pendingInputs: expect.any(Array),
      });
      expect(snapshot.bashApprovalGrants ?? []).toEqual([]);
      expect(JSON.stringify(snapshot).includes("sk-secret-queued-214")).toBe(
        false,
      );
      expect(
        JSON.stringify(snapshot).includes("live-secret-approval-token"),
      ).toBe(false);
      expect(JSON.stringify(snapshot).includes("[REDACTED_SECRET]")).toBe(true);
      expect(
        JSON.stringify(resumed.pendingInputs).includes("sk-secret-queued-214"),
      ).toBe(false);
      expect(
        JSON.stringify(resumed.bashApprovalGrants).includes(
          "live-secret-approval-token",
        ),
      ).toBe(false);
      expect(resumed.bashApprovalGrants).toEqual([]);
      expect(
        JSON.stringify(resumed.pendingInputs).includes("[REDACTED_SECRET]"),
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a bash approval audit record contains a secret-like command,
    When the session is resumed before snapshot compaction,
    Then the redacted audit record is not replayed as an active approval`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const grant = {
      type: "exact",
      cwd: ledgerWorkspace,
      command: "printf 'Bearer live-secret-approval-token'",
    } satisfies BashApprovalGrant;

    try {
      const session = createSessionStore({
        sessionId: "redacted-bash-approval-resume",
        workspace,
        runtime: runtime(home),
      });
      persistSessionBashApprovalGrant({
        session,
        grant,
        runtime: runtime(home, 1),
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "redacted-bash-approval-resume",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines).toHaveLength(2);
      expect(ledgerLines[1]).toMatchObject({
        type: "bash_approval_granted",
        grant: {
          type: "exact",
          cwd: ledgerWorkspace,
          command: "printf 'Bearer [REDACTED_SECRET]'",
        },
      });
      expect(JSON.stringify(ledgerLines)).not.toContain(
        "live-secret-approval-token",
      );
      expect(session.bashApprovalGrants).toEqual([]);
      expect(resumed.bashApprovalGrants).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
