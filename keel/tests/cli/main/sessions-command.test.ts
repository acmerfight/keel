import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  appendSessionRecordLine,
  conversationCheckpoint,
  endForkGraph,
  inputAdmittedRecordLine,
  inputConsumedRecordLine,
  replaceSessionRecordLine,
  snapshotSessionRecordLine,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";

describe("CLI Main - Sessions Command", () => {
  test(`Given no persisted sessions for the current workspace,
    When the user lists sessions,
    Then the CLI reports an empty catalog without contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "deepseek",
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe(
        `No sessions for workspace ${await realpath(workspace)}.\n`,
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an unsupported sessions option,
    When the user lists sessions,
    Then the CLI exits with a validation error`, async () => {
    // Given
    const fixture = createRuntime(["sessions", "--all"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown sessions option "--all"\n');
  });

  test(`Given sessions fork is missing the target session id,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime(["sessions", "fork", "source"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: sessions fork requires <source-id> <target-id>.\n",
    );
  });

  test(`Given sessions fork receives an empty fork point,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "sessions",
      "fork",
      "source",
      "target",
      "--before-message=",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --before-message requires a value.\n",
    );
  });

  test(`Given sessions fork is passed a fork point flag without a value,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "sessions",
      "fork",
      "source",
      "target",
      "--before-message",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --before-message requires a value.\n",
    );
  });

  test(`Given sessions fork receives an unsupported option,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "sessions",
      "fork",
      "source",
      "target",
      "--all",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: unknown sessions fork option "--all"\n',
    );
  });

  test(`Given persisted sessions exist across workspaces,
    When the user lists sessions,
    Then the CLI shows only current workspace sessions with previews and resume commands`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const otherWorkspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const otherLedgerWorkspace = await realpath(otherWorkspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const longPrompt = `remember ${"0123456789".repeat(14)}`;
    const longPromptPreview = `${longPrompt.slice(0, 117)}...`;
    const olderLastMessageId = "msg_append-2026-01-01T00_00_06_000Z_2";
    await writeSessionLedger({
      home,
      id: "long-preview",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-04T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-04T00:00:05.000Z", [
          { role: "user", content: longPrompt },
          {
            role: "assistant",
            content: "Remembered long prompt.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "older",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          { role: "user", content: "remember alpha" },
          {
            role: "assistant",
            content: "Remembered alpha.",
            toolCalls: [],
          },
        ]),
        appendSessionRecordLine("2026-01-01T00:00:06.000Z", [
          { role: "user", content: "remember alpha later" },
          {
            role: "assistant",
            content: "Remembered later alpha.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "forked",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      parentSessionId: "older",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          { role: "user", content: "remember beta\nwith spacing" },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });
    for (const branchId of ["branch-b", "branch-a"]) {
      await writeSessionLedger({
        home,
        id: branchId,
        workspace: ledgerWorkspace,
        createdAt: "2026-01-02T00:00:00.000Z",
        graph: endForkGraph({
          sessionId: branchId,
          parentSessionId: "older",
          sourceLastMessageId: olderLastMessageId,
          sourceOrdinal: 4,
        }),
        records: [
          appendSessionRecordLine("2026-01-02T00:00:06.000Z", [
            { role: "user", content: `remember ${branchId}` },
            {
              role: "assistant",
              content: `Remembered ${branchId}.`,
              toolCalls: [],
            },
          ]),
        ],
      });
    }
    await writeSessionLedger({
      home,
      id: "compacted",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T18:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T18:00:01.000Z", [
          { role: "user", content: "old compacted prompt" },
          {
            role: "assistant",
            content: "Old compacted answer.",
            toolCalls: [],
          },
        ]),
        replaceSessionRecordLine("2026-01-01T18:00:02.000Z", [
          {
            role: "user",
            content: conversationCheckpoint("Old task summarized."),
          },
          { role: "user", content: "remember compacted" },
          {
            role: "assistant",
            content: "Remembered compacted.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "checkpoint-only",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T18:30:00.000Z",
      records: [
        replaceSessionRecordLine("2026-01-01T18:30:02.000Z", [
          {
            role: "user",
            content: conversationCheckpoint(
              "Only checkpoint summary remains.",
              true,
            ),
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "snapshotted",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T17:00:00.000Z",
      records: [
        snapshotSessionRecordLine("2026-01-01T17:00:02.000Z", [
          { role: "user", content: "remember snapshot" },
          {
            role: "assistant",
            content: "Remembered snapshot.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "queued",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T16:00:00.000Z",
      records: [
        inputAdmittedRecordLine({
          timestamp: "2026-01-01T16:00:01.000Z",
          id: "queued-catalog-input",
          line: "remember queued",
        }),
        inputConsumedRecordLine("2026-01-01T16:00:02.000Z", [
          "queued-catalog-input",
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "tie-a",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T15:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T15:00:01.000Z", [
          { role: "user", content: "remember tie a" },
          {
            role: "assistant",
            content: "Remembered tie a.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "tie-b",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T15:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T15:00:01.000Z", [
          { role: "user", content: "remember tie b" },
          {
            role: "assistant",
            content: "Remembered tie b.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "empty",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T12:00:00.000Z",
    });
    await writeSessionLedger({
      home,
      id: "elsewhere",
      workspace: otherLedgerWorkspace,
      createdAt: "2026-01-03T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-03T00:00:05.000Z", [
          { role: "user", content: "do not show this session" },
          {
            role: "assistant",
            content: "Hidden.",
            toolCalls: [],
          },
        ]),
      ],
    });
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      const stdout = fixture.stdout();
      expect(stdout).toContain(`Sessions for workspace ${ledgerWorkspace}:\n`);
      expect(stdout).toContain(
        "graph long-preview root long-preview  updated 2026-01-04T00:00:05.000Z\n",
      );
      expect(stdout).toContain(
        "long-preview  updated 2026-01-04T00:00:05.000Z\n",
      );
      expect(stdout).toContain("   branch: main\n");
      expect(stdout).toContain(`   preview: ${longPromptPreview}\n`);
      expect(stdout).toContain(
        "graph older root older  updated 2026-01-02T00:00:06.000Z\n",
      );
      expect(stdout).toContain("older  updated 2026-01-01T00:00:06.000Z\n");
      expect(stdout).toContain(
        [
          "  branch-a  updated 2026-01-02T00:00:06.000Z",
          "     branch: branch-a",
          "     parent: older",
          `     fork point: full restored history from older through message ${olderLastMessageId} (message 4)`,
          "     fork policy: transcript=copy_prefix, pendingInputs=drop, queuedInputs=drop, bashApprovalGrants=drop",
          "     preview: remember branch-a",
          "     resume: keel --resume branch-a",
          "     fork-points: keel --resume branch-a --fork-points",
          "     fork: keel sessions fork branch-a <new-id>",
          "  branch-b  updated 2026-01-02T00:00:06.000Z",
        ].join("\n"),
      );
      expect(stdout).toContain("  forked  updated 2026-01-02T00:00:05.000Z\n");
      expect(stdout).toContain("     parent: older\n");
      expect(stdout).toContain("     preview: remember beta with spacing\n");
      expect(stdout).toContain(
        "     fork policy: transcript=copy_prefix, pendingInputs=drop, queuedInputs=drop, bashApprovalGrants=drop\n",
      );
      expect(stdout).toContain(
        "checkpoint-only  updated 2026-01-01T18:30:02.000Z\n",
      );
      expect(stdout).toContain("compacted  updated 2026-01-01T18:00:02.000Z\n");
      expect(stdout).toContain(
        "snapshotted  updated 2026-01-01T17:00:02.000Z\n",
      );
      expect(stdout).toContain("queued  updated 2026-01-01T16:00:02.000Z\n");
      expect(stdout).toContain("tie-a  updated 2026-01-01T15:00:01.000Z\n");
      expect(stdout).toContain("tie-b  updated 2026-01-01T15:00:01.000Z\n");
      expect(stdout).toContain("empty  updated 2026-01-01T12:00:00.000Z\n");
      expect(stdout).toContain("   fork: keel sessions fork older <new-id>\n");
      expect(stdout).not.toContain("elsewhere");
      expect(stdout).not.toContain("do not show this session");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(otherWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given restored session messages do not contain user prompts,
    When the user lists sessions,
    Then the CLI falls back to an empty user preview`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const malformedCheckpoint = conversationCheckpoint(
      "Malformed checkpoint should be treated as ordinary user text.",
    ).replace("<summary>", "<body>");
    const malformedCheckpointPreview = `${malformedCheckpoint
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 117)}...`;
    await writeSessionLedger({
      home,
      id: "malformed-checkpoint",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T18:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T18:00:01.000Z", [
          { role: "user", content: malformedCheckpoint },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "assistant-only",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T17:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T17:00:01.000Z", [
          {
            role: "assistant",
            content: "No restored user prompt.",
            toolCalls: [],
          },
        ]),
      ],
    });
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      const stdout = fixture.stdout();
      expect(stdout).toContain(`Sessions for workspace ${ledgerWorkspace}:\n`);
      expect(stdout).toContain(
        "graph malformed-checkpoint root malformed-checkpoint  updated 2026-01-01T18:00:01.000Z\n",
      );
      expect(stdout).toContain(
        "malformed-checkpoint  updated 2026-01-01T18:00:01.000Z\n",
      );
      expect(stdout).toContain("   branch: main\n");
      expect(stdout).toContain(`   preview: ${malformedCheckpointPreview}\n`);
      expect(stdout).toContain(
        "graph assistant-only root assistant-only  updated 2026-01-01T17:00:01.000Z\n",
      );
      expect(stdout).toContain(
        "assistant-only  updated 2026-01-01T17:00:01.000Z\n",
      );
      expect(stdout).toContain("   preview: (no restored user messages)\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given persisted sessions have workflow skills,
    When the user lists sessions,
    Then the CLI shows each bound skill name and path without printing the skill body`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const workflowSkill = {
      name: "review",
      relativePath: ".agents/skills/review/SKILL.md",
      resourcePaths: ["references/checklist.md"],
      content: "Secret review workflow body.",
    };
    await writeSessionLedger({
      home,
      id: "skilled",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      workflowSkill,
      records: [
        appendSessionRecordLine("2026-01-01T00:00:01.000Z", [
          { role: "user", content: "review PR" },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "skilled-fork",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:02.000Z",
      workflowSkill,
      graph: endForkGraph({
        sessionId: "skilled-fork",
        parentSessionId: "skilled",
        sourceLastMessageId: "msg_append-2026-01-01T00_00_01_000Z_1",
        sourceOrdinal: 1,
      }),
      records: [
        appendSessionRecordLine("2026-01-01T00:00:03.000Z", [
          { role: "user", content: "continue review" },
        ]),
      ],
    });
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      const stdout = fixture.stdout();
      expect(stdout).toContain(
        "   workflow skill: review (.agents/skills/review/SKILL.md)\n",
      );
      expect(stdout).toContain(
        "     workflow skill: review (.agents/skills/review/SKILL.md)\n",
      );
      expect(stdout).not.toContain("Secret review workflow body.");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one session ledger is damaged,
    When the user lists sessions,
    Then the CLI warns and still shows the valid sessions`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "good",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:01.000Z", [
          { role: "user", content: "remember good" },
          {
            role: "assistant",
            content: "Remembered good.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "broken",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: ["not json"],
    });
    await writeSessionLedger({
      home,
      id: "mismatched",
      headerId: "other-session",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("good  updated");
      expect(fixture.stdout()).toContain("   preview: remember good\n");
      expect(fixture.stdout()).not.toContain("broken  updated");
      expect(fixture.stderr()).toContain(
        'Warning: skipped session "broken": cannot load session ledger',
      );
      expect(fixture.stderr()).toContain("line 2 is not valid JSON");
      expect(fixture.stderr()).toContain(
        'Warning: skipped session "mismatched": ledger belongs to session "other-session", not "mismatched".',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session catalog storage cannot be scanned,
    When the user lists sessions,
    Then the CLI reports the catalog load failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionsPath = join(home, "sessions");
    await writeFile(sessionsPath, "not a directory", "utf8");
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        `Error: cannot list sessions at ${sessionsPath}:`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
