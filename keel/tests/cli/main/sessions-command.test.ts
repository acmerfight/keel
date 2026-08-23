import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { acquireSessionLock } from "../../../src/cli/session-store.ts";
import { skillActivationFromWorkflowSkill } from "../../../src/skills/lifecycle.ts";
import type { WorkflowSkill } from "../../../src/skills/model.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  appendSessionRecordLine,
  beforeMessageForkGraph,
  conversationCheckpoint,
  endForkGraph,
  inputAdmittedRecordLine,
  inputConsumedRecordLine,
  replaceSessionRecordLine,
  sessionGoalRecordLine,
  sessionTitleRecordLine,
  snapshotSessionRecordLine,
  storedMessages,
  taskProgressRecordLine,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";

function skillState(workflowSkill: WorkflowSkill) {
  const activation = skillActivationFromWorkflowSkill({
    skill: workflowSkill,
    trigger: "user_explicit",
    args: "",
    activatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    skillActivations: [activation],
    activeSkillIds: [activation.descriptorId],
  };
}

function modelSwitchRecordLine(timestamp: string): string {
  return JSON.stringify({
    schemaVersion: 11,
    type: "model_switch",
    timestamp,
    from: null,
    to: { providerId: "qwen", model: "qwen3.7-max" },
  });
}

function detailTimestamp(index: number): string {
  return `2026-02-02T00:00:${index.toString().padStart(2, "0")}.000Z`;
}

describe("CLI Main - Sessions Command", () => {
  test(`Given a saved session has transcript and agent history,
    When the user archives, lists, and unarchives it,
    Then normal discovery hides it and restoration preserves the complete session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionId = "finished-task";
    const activeDirectory = join(home, "sessions", sessionId);
    const archivedDirectory = join(home, "archived-sessions", sessionId);
    const agentTranscriptPath = join(
      activeDirectory,
      "agents",
      "transcripts",
      "child.jsonl",
    );
    const agentTranscript = '{"type":"child_result","content":"kept"}\n';
    await writeSessionLedger({
      home,
      id: sessionId,
      workspace: ledgerWorkspace,
      createdAt: "2026-08-21T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-08-21T00:00:01.000Z", [
          {
            role: "user",
            content: "preserve this completed task",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "The task is complete.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await mkdir(join(activeDirectory, "agents", "transcripts"), {
      recursive: true,
    });
    await writeFile(agentTranscriptPath, agentTranscript, "utf8");
    const activeLedger = await readFile(join(activeDirectory, "ledger.jsonl"));
    const archive = createRuntime(["sessions", "archive", sessionId], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });

    try {
      // When
      expect(await runCliMain(archive.runtime)).toBe(0);

      // Then
      expect(archive.stderr()).toBe("");
      expect(archive.stdout()).toBe(
        `Archived session "${sessionId}".\nunarchive: keel sessions unarchive ${sessionId}\n`,
      );
      await expect(
        readFile(join(activeDirectory, "ledger.jsonl")),
      ).rejects.toThrow();
      expect(await readFile(join(archivedDirectory, "ledger.jsonl"))).toEqual(
        activeLedger,
      );
      expect(
        await readFile(
          join(archivedDirectory, "agents", "transcripts", "child.jsonl"),
          "utf8",
        ),
      ).toBe(agentTranscript);

      const activeList = createRuntime(["sessions"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(await runCliMain(activeList.runtime)).toBe(0);
      expect(activeList.stdout()).toBe(
        `No sessions for workspace ${ledgerWorkspace}.\n`,
      );

      await writeSessionLedger({
        home,
        id: "current-task",
        workspace: ledgerWorkspace,
        createdAt: "2026-08-21T00:00:02.000Z",
      });
      const pickerInput = new PassThrough();
      pickerInput.end("q\n");
      const picker = createRuntime(["--resume", "--pick"], {
        cwd: workspace,
        env: { KEEL_HOME: home, KEEL_PROVIDER: "fake" },
        input: pickerInput,
        inputIsTTY: true,
        stderrIsTTY: false,
      });
      expect(await runCliMain(picker.runtime)).toBe(0);
      expect(picker.stdout()).toContain(
        "Select session [1-1], or q to cancel:\n",
      );
      expect(picker.stdout()).toContain("1. current-task  updated");
      expect(picker.stdout()).not.toContain(sessionId);

      const archivedList = createRuntime(["sessions", "archived"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(await runCliMain(archivedList.runtime)).toBe(0);
      expect(archivedList.stderr()).toBe("");
      expect(archivedList.stdout()).toContain(
        `Archived sessions for workspace ${ledgerWorkspace}:\n`,
      );
      expect(archivedList.stdout()).toContain(
        `${sessionId}  updated 2026-08-21T00:00:01.000Z\n`,
      );
      expect(archivedList.stdout()).toContain(
        `   unarchive: keel sessions unarchive ${sessionId}\n`,
      );
      expect(archivedList.stdout()).not.toContain("resume: keel --resume");

      const archivedResume = createRuntime(
        ["--resume", sessionId, "--fork-points"],
        {
          cwd: workspace,
          env: { KEEL_HOME: home },
        },
      );
      expect(await runCliMain(archivedResume.runtime)).toBe(1);
      expect(archivedResume.stdout()).toBe("");
      expect(archivedResume.stderr()).toContain(
        `Error: cannot resume session "${sessionId}": session ledger not found at ${join(activeDirectory, "ledger.jsonl")}.`,
      );

      const unarchive = createRuntime(["sessions", "unarchive", sessionId], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(await runCliMain(unarchive.runtime)).toBe(0);
      expect(unarchive.stderr()).toBe("");
      expect(unarchive.stdout()).toBe(
        `Unarchived session "${sessionId}".\nresume: keel --resume ${sessionId}\n`,
      );

      const restored = createRuntime(["sessions", "show", sessionId, "--all"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(await runCliMain(restored.runtime)).toBe(0);
      expect(restored.stderr()).toBe("");
      expect(restored.stdout()).toContain("preserve this completed task");
      expect(await readFile(agentTranscriptPath, "utf8")).toBe(agentTranscript);

      const emptyArchive = createRuntime(["sessions", "archived"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(await runCliMain(emptyArchive.runtime)).toBe(0);
      expect(emptyArchive.stdout()).toBe(
        `No archived sessions for workspace ${ledgerWorkspace}.\n`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    {
      args: ["sessions", "archive"],
      error: "Error: sessions archive requires <id>.\n",
    },
    {
      args: ["sessions", "unarchive"],
      error: "Error: sessions unarchive requires <id>.\n",
    },
    {
      args: ["sessions", "archive", "task", "--force"],
      error: 'Error: unknown sessions archive option "--force"\n',
    },
    {
      args: ["sessions", "archived", "extra"],
      error: 'Error: unknown sessions archived option "extra"\n',
    },
  ])(
    `Given an incomplete or unsupported session lifecycle command,
    When the CLI parses $args,
    Then it rejects the command without moving session data`,
    async ({ args, error }) => {
      const fixture = createRuntime(args);

      expect(await runCliMain(fixture.runtime)).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(error);
    },
  );

  test(`Given a saved session is owned by a live process,
    When the user tries to archive it,
    Then the CLI refuses without moving any session data`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionId = "active-task";
    const ledgerPath = join(home, "sessions", sessionId, "ledger.jsonl");
    await writeSessionLedger({
      home,
      id: sessionId,
      workspace: ledgerWorkspace,
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    const fixture = createRuntime(["sessions", "archive", sessionId], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });
    const lock = acquireSessionLock({ sessionId, runtime: fixture.runtime });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        `Error: session "${sessionId}" is already active. Stop the other Keel process before using it again.\n`,
      );
      expect(lock.lockPath).toBe(join(home, "session-locks", sessionId));
      await expect(readFile(ledgerPath)).resolves.not.toHaveLength(0);
      await expect(
        readFile(join(home, "archived-sessions", sessionId, "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      lock.release();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed Task accepted an interrupted opaque effect,
    When the host lists or inspects the saved session after a later state mutation,
    Then the catalog preserves and displays the unknown-effect outcome`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionId = "accepted-unknown-outcome";
    const operationId = "tool_operation_unknown";
    const taskId = "task_unknown";
    const runId = "run_unknown";
    const messages = storedMessages(
      [
        {
          role: "user",
          content: "perform one opaque effect",
          origin: { type: "user_prompt" },
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "write_unknown",
              tool: "write",
              path: "result.txt",
              content: "possibly written\n",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "write_unknown",
          content: "effect state is unknown after restart",
          recovery: {
            kind: "interrupted_effect_unknown",
            taskId,
            runId,
            operationId,
          },
        },
        {
          role: "assistant",
          content: "continued without repeating the effect",
          toolCalls: [],
        },
      ],
      "accepted-unknown",
    );
    await writeSessionLedger({
      home,
      id: sessionId,
      workspace: ledgerWorkspace,
      createdAt: "2026-08-16T00:00:00.000Z",
      records: [
        JSON.stringify({
          schemaVersion: 11,
          type: "snapshot",
          timestamp: "2026-08-16T00:00:01.000Z",
          reason: "size_threshold",
          messages,
          pendingInputs: [],
          skillStateCheckpoints: [
            { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
          ],
          lastTaskOutcome: {
            taskId,
            runId,
            outcome: "completed_with_unknown_effects",
            timestamp: "2026-08-16T00:00:01.000Z",
            recovered: true,
            unknownProviderAttemptIds: [],
            unknownToolEffectOperationIds: [operationId],
            responseMessageId: messages[3]?.id,
          },
        }),
        sessionGoalRecordLine({
          timestamp: "2026-08-16T00:00:02.000Z",
          goal: null,
        }),
      ],
    });
    const listed = createRuntime(["sessions"], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });
    const shown = createRuntime(["sessions", "show", sessionId, "--all"], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(listed.runtime)).toBe(0);
      expect(listed.stderr()).toBe("");
      expect(listed.stdout()).toContain(
        "last task: completed_with_unknown_effects; unknown tool effects: 1",
      );
      expect(await runCliMain(shown.runtime)).toBe(0);
      expect(shown.stderr()).toBe("");
      expect(shown.stdout()).toContain(
        "last task: completed_with_unknown_effects; unknown tool effects: 1",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a valid session ledger ends with an incomplete JSON fragment,
    When the user resumes the session normally,
    Then the CLI fails closed, preserves the ledger, and points to explicit repair`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionId = "crash-tail";
    const ledgerPath = join(home, "sessions", sessionId, "ledger.jsonl");
    await writeSessionLedger({
      home,
      id: sessionId,
      workspace: ledgerWorkspace,
      createdAt: "2026-04-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-04-01T00:00:01.000Z", [
          {
            role: "user",
            content: "remember the validated prefix",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "The validated prefix is safe.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await appendFile(
      ledgerPath,
      '{"schemaVersion?":8,"type":"append","timestamp":"2026-04',
      "utf8",
    );
    const originalLedger = await readFile(ledgerPath);
    const input = new PassThrough();
    input.end("this should not run\n");
    const fixture = createRuntime(["--resume", sessionId], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "fake",
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        `keel sessions repair ${sessionId} --truncate-incomplete-tail`,
      );
      expect(await readFile(ledgerPath)).toEqual(originalLedger);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a valid session ledger ends with an incomplete JSON fragment,
    When the user explicitly truncates the incomplete tail,
    Then the CLI backs up the original and restores the last validated state`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionId = "crash-tail";
    const ledgerPath = join(home, "sessions", sessionId, "ledger.jsonl");
    const incompleteTail =
      '{"schemaVersion?":8,"type":"append","timestamp":"2026-04';
    await writeSessionLedger({
      home,
      id: sessionId,
      workspace: ledgerWorkspace,
      createdAt: "2026-04-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-04-01T00:00:01.000Z", [
          {
            role: "user",
            content: "remember the validated prefix",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "The validated prefix is safe.",
            toolCalls: [],
          },
        ]),
      ],
    });
    const validatedLedger = await readFile(ledgerPath);
    await appendFile(ledgerPath, incompleteTail, "utf8");
    const originalLedger = await readFile(ledgerPath);
    const repairedAt = Date.parse("2026-04-01T12:34:56.789Z");
    const backupPath = join(
      home,
      "sessions",
      sessionId,
      "ledger.backup-2026-04-01T12-34-56-789Z.jsonl",
    );
    const repair = createRuntime(
      ["sessions", "repair", sessionId, "--truncate-incomplete-tail"],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
        now: () => repairedAt,
      },
    );

    try {
      // When
      const repairExitCode = await runCliMain(repair.runtime);

      // Then
      expect(repairExitCode).toBe(0);
      expect(repair.stderr()).toBe("");
      expect(repair.stdout()).toBe(
        [
          `Recovered session "${sessionId}" to its last validated record.`,
          `Dropped ${Buffer.byteLength(incompleteTail)} incomplete bytes from the JSONL tail.`,
          `Original ledger preserved at: ${backupPath}`,
          `resume: keel --resume ${sessionId}`,
          "",
        ].join("\n"),
      );
      expect(await readFile(ledgerPath)).toEqual(validatedLedger);
      expect(await readFile(backupPath)).toEqual(originalLedger);

      const show = createRuntime(["sessions", "show", sessionId, "--all"], {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      });
      expect(await runCliMain(show.runtime)).toBe(0);
      expect(show.stderr()).toBe("");
      expect(show.stdout()).toContain("remember the validated prefix");
      expect(show.stdout()).toContain("The validated prefix is safe.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

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

  test.each([
    {
      args: ["sessions", "repair"],
      error: "Error: sessions repair requires <id>.\n",
    },
    {
      args: ["sessions", "repair", "broken"],
      error: "Error: sessions repair requires --truncate-incomplete-tail.\n",
    },
    {
      args: ["sessions", "repair", "broken", "--all"],
      error: 'Error: unknown sessions repair option "--all"\n',
    },
    {
      args: [
        "sessions",
        "repair",
        "broken",
        "--truncate-incomplete-tail",
        "--all",
      ],
      error: 'Error: unknown sessions repair option "--all"\n',
    },
  ])(
    `Given an incomplete or unsupported sessions repair command,
    When the CLI parses $args,
    Then it rejects the command without guessing a repair strategy`,
    async ({ args, error }) => {
      const fixture = createRuntime(args);

      expect(await runCliMain(fixture.runtime)).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(error);
    },
  );

  test(`Given saved sessions have active and completed goals,
    When the user lists sessions,
    Then the catalog shows each goal before the resume command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "active-goal",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-03T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-03-03T00:00:01.000Z", [
          {
            role: "user",
            content: "fix resume status",
            origin: { type: "user_prompt" },
          },
        ]),
        sessionGoalRecordLine({
          timestamp: "2026-03-03T00:00:02.000Z",
          goal: {
            objective: "Fix the session resume flow",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            completion: {
              kind: "command",
              command: 'node  -e "process.exit(0)"',
            },
          },
        }),
      ],
    });
    await writeSessionLedger({
      home,
      id: "completed-goal",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-03T00:00:03.000Z",
      records: [
        appendSessionRecordLine("2026-03-03T00:00:04.000Z", [
          {
            role: "user",
            content: "ship release notes",
            origin: { type: "user_prompt" },
          },
        ]),
        sessionGoalRecordLine({
          timestamp: "2026-03-03T00:00:05.000Z",
          goal: {
            objective: "Ship the release notes",
            status: "completed",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            completionEvidence: { kind: "user_override" },
            latestRuntimeOutcome: {
              kind: "completed",
              reason: "The user explicitly completed the goal.",
            },
          },
        }),
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
        '   goal: active - Fix the session resume flow; criterion(command): node  -e "process.exit(0)"\n',
      );
      expect(stdout).toContain(
        "   goal: completed - Ship the release notes; criterion: missing\n",
      );
      expect(stdout).toContain(
        "   goal outcome: completed - The user explicitly completed the goal.\n",
      );
      expect(stdout).toContain(
        "   goal evidence: user explicitly completed the goal with /goal complete\n",
      );
      expect(stdout.indexOf("   goal: active")).toBeLessThan(
        stdout.indexOf("   resume: keel --resume active-goal"),
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved session goal is cleared after a title is set,
    When the user lists sessions,
    Then the catalog preserves the title without showing a stale goal`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "cleared-goal",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-04T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-03-04T00:00:01.000Z", [
          {
            role: "user",
            content: "clean stale goal state",
            origin: { type: "user_prompt" },
          },
        ]),
        sessionTitleRecordLine(
          "2026-03-04T00:00:02.000Z",
          "Clean stale goal state",
        ),
        sessionGoalRecordLine({
          timestamp: "2026-03-04T00:00:03.000Z",
          goal: {
            objective: "Remove stale goal from catalog",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          },
        }),
        sessionGoalRecordLine({
          timestamp: "2026-03-04T00:00:04.000Z",
          goal: null,
        }),
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
        "cleared-goal  updated 2026-03-04T00:00:04.000Z\n",
      );
      expect(stdout).toContain("   title: Clean stale goal state\n");
      expect(stdout).not.toContain("Remove stale goal from catalog");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved session has active task progress and queued input,
    When the user lists sessions,
    Then the catalog shows recovery status before the resume command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "active",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-03-01T00:00:01.000Z", [
          {
            role: "user",
            content: "fix resume status",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "I will inspect session recovery.",
            toolCalls: [],
          },
        ]),
        taskProgressRecordLine({
          timestamp: "2026-03-01T00:00:02.000Z",
          tasks: [
            { step: "Inspect session recovery", status: "completed" },
            { step: "Patch catalog status", status: "in_progress" },
            { step: "Verify resume picker", status: "pending" },
          ],
        }),
        inputAdmittedRecordLine({
          timestamp: "2026-03-01T00:00:03.000Z",
          id: "active-follow-up",
          line: "also update the startup prompt",
        }),
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
      expect(stdout).toContain("active  updated 2026-03-01T00:00:03.000Z\n");
      expect(stdout).toContain(
        "   tasks: 1/3 completed; current: Patch catalog status\n",
      );
      expect(stdout).toContain("   pending inputs: 1\n");
      expect(stdout.indexOf("   tasks:")).toBeLessThan(
        stdout.indexOf("   resume: keel --resume active"),
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved session snapshot contains recovery state,
    When the user lists sessions,
    Then the catalog shows the snapshotted task progress and pending inputs`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "snapshotted-active",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-02T00:00:00.000Z",
      records: [
        snapshotSessionRecordLine(
          "2026-03-02T00:00:01.000Z",
          [
            {
              role: "user",
              content: "continue snapshot task",
              origin: { type: "user_prompt" },
            },
            {
              role: "assistant",
              content: "Continuing.",
              toolCalls: [],
            },
          ],
          undefined,
          {
            pendingInputs: [
              {
                id: "snapshot-follow-up",
                timestamp: "2026-03-02T00:00:00.500Z",
                sequence: 1,
                line: "also update picker",
              },
            ],
            goal: {
              objective: "Finish snapshotted recovery state",
              status: "active",
              budget: {},
              usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            },
            taskProgressCheckpoints: [
              {
                messageOrdinal: 0,
                taskProgress: {
                  tasks: [
                    { step: "Restore snapshot state", status: "completed" },
                    { step: "Render recovery status", status: "in_progress" },
                  ],
                },
              },
            ],
          },
        ),
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
        "snapshotted-active  updated 2026-03-02T00:00:01.000Z\n",
      );
      expect(stdout).toContain(
        "   tasks: 1/2 completed; current: Render recovery status\n",
      );
      expect(stdout).toContain(
        "   goal: active - Finish snapshotted recovery state; criterion: missing\n",
      );
      expect(stdout).toContain("   pending inputs: 1\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved session inputs are consumed by input records and mutations,
    When the user lists sessions,
    Then the catalog only counts inputs still waiting for the next turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "partly-consumed",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-03T00:00:00.000Z",
      records: [
        inputAdmittedRecordLine({
          timestamp: "2026-03-03T00:00:01.000Z",
          id: "first-input",
          line: "first follow-up",
        }),
        inputAdmittedRecordLine({
          timestamp: "2026-03-03T00:00:02.000Z",
          id: "second-input",
          line: "second follow-up",
        }),
        inputConsumedRecordLine("2026-03-03T00:00:03.000Z", ["first-input"]),
        inputAdmittedRecordLine({
          timestamp: "2026-03-03T00:00:04.000Z",
          id: "third-input",
          line: "third follow-up",
        }),
        sessionTitleRecordLine(
          "2026-03-03T00:00:05.000Z",
          "Partly consumed input",
          { consumedInputIds: ["second-input"] },
        ),
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
        "partly-consumed  updated 2026-03-03T00:00:05.000Z\n",
      );
      expect(stdout).toContain("   pending inputs: 1\n");
      expect(stdout).not.toContain("pending inputs: 2");
      expect(stdout).not.toContain("pending inputs: 3");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
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

  test(`Given sessions fork names a missing source session,
    When the user forks it into a new session,
    Then the CLI reports the supported resume error without creating the target`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const fixture = createRuntime(
      ["sessions", "fork", "missing-source", "target"],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        'Error: cannot resume session "missing-source": session ledger not found at ',
      );
      expect(fixture.stderr()).toContain(
        join(home, "sessions", "missing-source", "ledger.jsonl"),
      );
      await expect(
        realpath(join(home, "sessions", "target", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given sessions show is missing or receives invalid options,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    const cases = [
      {
        args: ["sessions", "show"],
        stderr: "Error: sessions show requires <id>.\n",
      },
      {
        args: ["sessions", "show", ""],
        stderr: "Error: sessions show requires <id>.\n",
      },
      {
        args: ["sessions", "show", "detail", "--limit"],
        stderr: "Error: --limit requires a positive integer.\n",
      },
      {
        args: ["sessions", "show", "detail", "--limit="],
        stderr: "Error: --limit requires a positive integer.\n",
      },
      {
        args: ["sessions", "show", "detail", "--limit", "0"],
        stderr: "Error: --limit requires a positive integer.\n",
      },
      {
        args: ["sessions", "show", "detail", "--limit", "9007199254740992"],
        stderr: "Error: --limit requires a positive integer.\n",
      },
      {
        args: ["sessions", "show", "detail", "--all", "--limit", "2"],
        stderr: "Error: --all cannot be combined with --limit.\n",
      },
      {
        args: ["sessions", "show", "detail", "--bogus"],
        stderr: 'Error: unknown sessions show option "--bogus"\n',
      },
    ];

    for (const testCase of cases) {
      const fixture = createRuntime(testCase.args);

      const exitCode = await runCliMain(fixture.runtime);

      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(testCase.stderr);
    }
  });

  test(`Given a persisted session has restored state,
    When the user shows the session detail,
    Then the CLI prints redacted metadata, state, actions, and the full timeline`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const openAiKey = "sk-sessiondetailsecret";
    const githubToken = `ghp_${"a".repeat(24)}`;
    await writeSessionLedger({
      home,
      id: "detail",
      workspace: ledgerWorkspace,
      createdAt: "2026-02-01T00:00:00.000Z",
      graph: endForkGraph({
        sessionId: "detail",
        parentSessionId: "source",
        sourceLastMessageId: "source-last-message",
        sourceOrdinal: 7,
      }),
      skillState: skillState({
        id: "repo:test:review",
        packageId: "repo:test:review",
        digest: "digest",
        qualifiedName: "repo:review",
        scope: "repo",
        name: "review",
        relativePath: ".agents/skills/review/SKILL.md",
        resourcePaths: ["references/checklist.md"],
        content: "Do not print this workflow body.",
      }),
      records: [
        appendSessionRecordLine("2026-02-01T00:00:01.000Z", [
          {
            role: "user",
            origin: { type: "user_prompt" },
            content: `Use ${openAiKey} and \u001b[31mred text`,
          },
          {
            role: "assistant",
            content: "I will inspect package.",
            toolCalls: [
              {
                id: "read_package",
                tool: "read",
                path: "package.json",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "read_package",
            content: `package has ${githubToken} and \u001b[2Jclear`,
          },
          {
            role: "assistant",
            content: "Done.\nSecond line",
            toolCalls: [],
          },
        ]),
        modelSwitchRecordLine("2026-02-01T00:00:02.000Z"),
        sessionTitleRecordLine("2026-02-01T00:00:02.500Z", "Fix login timeout"),
        sessionGoalRecordLine({
          timestamp: "2026-02-01T00:00:02.600Z",
          goal: {
            objective: "Keep detail status goal visible",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          },
        }),
        taskProgressRecordLine({
          timestamp: "2026-02-01T00:00:02.750Z",
          tasks: [
            { step: "Inspect session detail", status: "completed" },
            { step: "Patch catalog status", status: "in_progress" },
          ],
        }),
        inputAdmittedRecordLine({
          timestamp: "2026-02-01T00:00:03.000Z",
          id: "queued-detail-input",
          line: "continue later",
        }),
      ],
    });
    const fixture = createRuntime(["sessions", "show", "detail", "--all"], {
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
      expect(stdout).toContain('Session "detail":\n');
      expect(stdout).toContain(`workspace: ${ledgerWorkspace}\n`);
      expect(stdout).toContain("created: 2026-02-01T00:00:00.000Z\n");
      expect(stdout).toContain("updated: 2026-02-01T00:00:03.000Z\n");
      expect(stdout).toContain("branch: detail\n");
      expect(stdout).toContain("title: Fix login timeout\n");
      expect(stdout).toContain("parent: source\n");
      expect(stdout).toContain(
        "workflow skill: repo:review (.agents/skills/review/SKILL.md)\n",
      );
      expect(stdout).toContain(
        "fork point: full restored history from source through message source-last-message (message 7)\n",
      );
      expect(stdout).toContain(
        "fork policy: transcript=copy_prefix, pendingInputs=drop, queuedInputs=drop\n",
      );
      expect(stdout).toContain("preview: Use [REDACTED_SECRET]");
      expect(stdout).toContain("status:\n");
      expect(stdout).toContain("  session: detail\n");
      expect(stdout).toContain("  title: Fix login timeout\n");
      expect(stdout).toContain(
        "  goal: active - Keep detail status goal visible; criterion: missing\n",
      );
      expect(stdout).toContain(`  workspace: ${ledgerWorkspace}\n`);
      expect(stdout).toContain("  active model: qwen/qwen3.7-max\n");
      expect(stdout).toContain(
        "  workflow skills: repo:review (.agents/skills/review/SKILL.md)\n",
      );
      expect(stdout).toContain("  messages: 4\n");
      expect(stdout).toContain("  pending inputs: 1\n");
      expect(stdout).toContain(
        "  tasks: 1/2 completed; current: Patch catalog status\n",
      );
      expect(stdout).toContain("  model switches: 1\n");
      expect(stdout).toContain("  latest checkpoint: none\n");
      expect(stdout).toContain("  undo checkpoints: 0\n");
      expect(stdout).toContain("recovery:\n");
      expect(stdout).toContain("  resume: keel --resume detail\n");
      expect(stdout).toContain(
        "  fork-points: keel --resume detail --fork-points\n",
      );
      expect(stdout).toContain("  fork: keel sessions fork detail <new-id>\n");
      expect(stdout).toContain("  undo-list: keel /undo --list\n");
      expect(stdout).toContain("Session tasks:\n");
      expect(stdout).toContain("  1. [completed] Inspect session detail\n");
      expect(stdout).toContain("  2. [in_progress] Patch catalog status\n");
      expect(stdout).toContain("state:\n");
      expect(stdout).toContain("  messages: 4\n");
      expect(stdout).toContain("  pending inputs: 1\n");
      expect(stdout).toContain("  active model: qwen/qwen3.7-max\n");
      expect(stdout).toContain("  model switches: 1\n");
      expect(stdout).toContain("actions:\n");
      expect(stdout).toContain("  resume: keel --resume detail\n");
      expect(stdout).toContain(
        "  fork-points: keel --resume detail --fork-points\n",
      );
      expect(stdout).toContain("  fork: keel sessions fork detail <new-id>\n");
      expect(stdout).toContain("timeline (all 4 messages):\n");
      expect(stdout).toContain(
        "1. user msg_append-2026-02-01T00_00_01_000Z_1: Use [REDACTED_SECRET] and \\x1b[31mred text\n",
      );
      expect(stdout).toContain(
        "2. assistant msg_append-2026-02-01T00_00_01_000Z_2: I will inspect package. | tool calls: read_package read package.json\n",
      );
      expect(stdout).toContain(
        "3. tool msg_append-2026-02-01T00_00_01_000Z_3: read_package: package has [REDACTED_SECRET] and \\x1b[2Jclear\n",
      );
      expect(stdout).toContain(
        "4. assistant msg_append-2026-02-01T00_00_01_000Z_4: Done. Second line\n",
      );
      expect(stdout).not.toContain(openAiKey);
      expect(stdout).not.toContain(githubToken);
      expect(stdout).not.toContain("\u001b");
      expect(stdout).not.toContain("Do not print this workflow body.");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session starts from a compaction checkpoint,
    When the user shows the session detail,
    Then the status snapshot reports the latest checkpoint summary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "compacted-detail",
      workspace: ledgerWorkspace,
      createdAt: "2026-02-06T00:00:00.000Z",
      records: [
        replaceSessionRecordLine("2026-02-06T00:00:01.000Z", [
          {
            role: "user",
            origin: { type: "compaction_checkpoint" },
            content: conversationCheckpoint("Old task summarized."),
          },
          {
            role: "user",
            content: "continue from the summary",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Continuing.",
            toolCalls: [],
          },
        ]),
      ],
    });
    const fixture = createRuntime(
      ["sessions", "show", "compacted-detail", "--all"],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("status:\n");
      expect(fixture.stdout()).toContain(
        "  latest checkpoint: Old task summarized.\n",
      );
      expect(fixture.stdout()).toContain("  messages: 3\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session id makes recovery commands long,
    When the user shows the session detail,
    Then the status snapshot prints copy-pasteable recovery commands`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionId = `long-${"a".repeat(230)}`;
    await writeSessionLedger({
      home,
      id: sessionId,
      workspace: ledgerWorkspace,
      createdAt: "2026-02-07T00:00:00.000Z",
    });
    const fixture = createRuntime(["sessions", "show", sessionId], {
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
      const statusStart = stdout.indexOf("status:\n");
      const stateStart = stdout.indexOf("state:\n");
      expect(statusStart).toBeGreaterThanOrEqual(0);
      expect(stateStart).toBeGreaterThan(statusStart);
      const statusSection = stdout.slice(statusStart, stateStart);
      expect(statusSection).toContain(`  resume: keel --resume ${sessionId}\n`);
      expect(statusSection).toContain(
        `  fork: keel sessions fork ${sessionId} <new-id>\n`,
      );
      expect(statusSection).not.toContain("...");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session has unsafe ledger identifiers,
    When the user shows the session detail,
    Then the CLI redacts secrets and escapes control bytes from identifiers`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const unsafeStoredMessageId = "msg-sk-messageidsecret\u001b[1m";
    const unsafeToolCallId = "call-sk-toolidsecret\u001b[2m";
    const unsafeModel = "qwen-sk-modelsecret\u001b[3m";
    const unsafeForkMessageId = "msg-sk-forkpointsecret\u001b[4m";
    const unsafeEndMessageId = "msg-sk-endpointsecret\u001b[5m";
    const unsafeForkPreview = "fork preview sk-previewsecret\u001b[6m";
    await writeSessionLedger({
      home,
      id: "unsafe-detail",
      workspace: ledgerWorkspace,
      createdAt: "2026-02-05T00:00:00.000Z",
      graph: beforeMessageForkGraph({
        sessionId: "unsafe-detail",
        parentSessionId: "source",
        sourceMessageId: unsafeForkMessageId,
        sourceOrdinal: 3,
        preview: unsafeForkPreview,
      }),
      records: [
        JSON.stringify({
          schemaVersion: 11,
          type: "append",
          timestamp: "2026-02-05T00:00:01.000Z",
          reason: "turn",
          messages: [
            {
              id: unsafeStoredMessageId,
              message: {
                role: "assistant",
                content: "I will inspect package.",
                toolCalls: [
                  {
                    id: unsafeToolCallId,
                    tool: "read",
                    path: "package.json",
                  },
                ],
              },
            },
            {
              id: "msg_tool",
              message: {
                role: "tool",
                toolCallId: unsafeToolCallId,
                content: "package contents",
              },
            },
            {
              id: "msg_final",
              message: {
                role: "assistant",
                content: "Done.",
                toolCalls: [],
              },
            },
          ],
        }),
        JSON.stringify({
          schemaVersion: 11,
          type: "model_switch",
          timestamp: "2026-02-05T00:00:02.000Z",
          from: null,
          to: { providerId: "qwen", model: unsafeModel },
        }),
      ],
    });
    await writeSessionLedger({
      home,
      id: "unsafe-end-detail",
      workspace: ledgerWorkspace,
      createdAt: "2026-02-05T00:00:03.000Z",
      graph: endForkGraph({
        sessionId: "unsafe-end-detail",
        parentSessionId: "source",
        sourceLastMessageId: unsafeEndMessageId,
        sourceOrdinal: 4,
      }),
    });
    const fixture = createRuntime(
      ["sessions", "show", "unsafe-detail", "--all"],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      },
    );
    const endFixture = createRuntime(
      ["sessions", "show", "unsafe-end-detail"],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      },
    );
    const listFixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);
      const endExitCode = await runCliMain(endFixture.runtime);
      const listExitCode = await runCliMain(listFixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      const stdout = fixture.stdout();
      expect(stdout).toContain(
        "fork point: before message msg-[REDACTED_SECRET]\\x1b[4m (message 3): fork preview [REDACTED_SECRET]\\x1b[6m\n",
      );
      expect(stdout).toContain(
        "active model: qwen/qwen-[REDACTED_SECRET]\\x1b[3m\n",
      );
      expect(stdout).toContain(
        "1. assistant msg-[REDACTED_SECRET]\\x1b[1m: I will inspect package. | tool calls: call-[REDACTED_SECRET]\\x1b[2m read package.json\n",
      );
      expect(stdout).toContain(
        "2. tool msg_tool: call-[REDACTED_SECRET]\\x1b[2m: package contents\n",
      );
      expect(stdout).not.toContain("sk-messageidsecret");
      expect(stdout).not.toContain("sk-toolidsecret");
      expect(stdout).not.toContain("sk-modelsecret");
      expect(stdout).not.toContain("sk-forkpointsecret");
      expect(stdout).not.toContain("sk-previewsecret");
      expect(stdout).not.toContain("\u001b");
      expect(fixture.stderr()).toBe("");

      expect(endExitCode).toBe(0);
      expect(endFixture.stdout()).toContain(
        "fork point: full restored history from source through message msg-[REDACTED_SECRET]\\x1b[5m (message 4)\n",
      );
      expect(endFixture.stdout()).not.toContain("sk-endpointsecret");
      expect(endFixture.stdout()).not.toContain("\u001b");
      expect(endFixture.stderr()).toBe("");

      expect(listExitCode).toBe(0);
      expect(listFixture.stdout()).toContain(
        "fork point: before message msg-[REDACTED_SECRET]\\x1b[4m (message 3): fork preview [REDACTED_SECRET]\\x1b[6m\n",
      );
      expect(listFixture.stdout()).toContain(
        "fork point: full restored history from source through message msg-[REDACTED_SECRET]\\x1b[5m (message 4)\n",
      );
      expect(listFixture.stdout()).not.toContain("sk-forkpointsecret");
      expect(listFixture.stdout()).not.toContain("sk-previewsecret");
      expect(listFixture.stdout()).not.toContain("sk-endpointsecret");
      expect(listFixture.stdout()).not.toContain("\u001b");
      expect(listFixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an empty persisted session,
    When the user shows the session detail,
    Then the CLI reports that no restored messages exist`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "empty-detail",
      workspace: ledgerWorkspace,
      createdAt: "2026-02-03T00:00:00.000Z",
    });
    const fixture = createRuntime(["sessions", "show", "empty-detail"], {
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
      expect(fixture.stdout()).toContain("state:\n  messages: 0\n");
      expect(fixture.stdout()).toContain(
        "timeline (0 messages):\n(no restored messages)\n",
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given sessions are unreadable or outside the current workspace,
    When the user shows those session details,
    Then the CLI reports the load failure without printing session contents`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const otherWorkspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const otherLedgerWorkspace = await realpath(otherWorkspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "elsewhere-detail",
      workspace: otherLedgerWorkspace,
      createdAt: "2026-02-04T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-02-04T00:00:01.000Z", [
          {
            role: "user",
            content: "do not reveal elsewhere",
            origin: { type: "user_prompt" },
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "broken-detail",
      workspace: ledgerWorkspace,
      createdAt: "2026-02-04T00:00:00.000Z",
      records: ["not json"],
    });
    await writeSessionLedger({
      home,
      id: "mismatched-detail",
      headerId: "other-detail",
      workspace: ledgerWorkspace,
      createdAt: "2026-02-04T00:00:00.000Z",
    });

    try {
      const elsewhere = createRuntime(
        ["sessions", "show", "elsewhere-detail"],
        {
          cwd: workspace,
          env: {
            KEEL_HOME: home,
          },
        },
      );
      const broken = createRuntime(["sessions", "show", "broken-detail"], {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      });
      const mismatched = createRuntime(
        ["sessions", "show", "mismatched-detail"],
        {
          cwd: workspace,
          env: {
            KEEL_HOME: home,
          },
        },
      );

      // When
      const elsewhereExitCode = await runCliMain(elsewhere.runtime);
      const brokenExitCode = await runCliMain(broken.runtime);
      const mismatchedExitCode = await runCliMain(mismatched.runtime);

      // Then
      expect(elsewhereExitCode).toBe(1);
      expect(elsewhere.stdout()).toBe("");
      expect(elsewhere.stderr()).toBe(
        `Error: cannot show session "elsewhere-detail": session workspace is ${otherLedgerWorkspace}, not ${ledgerWorkspace}.\n`,
      );
      expect(elsewhere.stderr()).not.toContain("do not reveal elsewhere");

      expect(brokenExitCode).toBe(1);
      expect(broken.stdout()).toBe("");
      expect(broken.stderr()).toContain(
        'Error: cannot show session "broken-detail": cannot load session ledger',
      );
      expect(broken.stderr()).toContain("line 2 is not valid JSON");

      expect(mismatchedExitCode).toBe(1);
      expect(mismatched.stdout()).toBe("");
      expect(mismatched.stderr()).toBe(
        'Error: cannot show session "mismatched-detail": ledger belongs to session "other-detail".\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(otherWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session has more than twenty restored messages,
    When the user shows the session without an explicit timeline limit,
    Then the CLI prints only the recent timeline and honors explicit limits`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "bounded",
      workspace: ledgerWorkspace,
      createdAt: "2026-02-02T00:00:00.000Z",
      records: Array.from({ length: 12 }, (_value, index) =>
        appendSessionRecordLine(detailTimestamp(index + 1), [
          {
            role: "user",
            origin: { type: "user_prompt" },
            content: `prompt ${(index + 1).toString().padStart(2, "0")}`,
          },
          {
            role: "assistant",
            content: `answer ${(index + 1).toString().padStart(2, "0")}`,
            toolCalls: [],
          },
        ]),
      ),
    });
    const fixture = createRuntime(["sessions", "show", "bounded"], {
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
      expect(stdout).toContain("timeline (last 20 of 24 messages):\n");
      expect(stdout).toContain(
        "4 earlier messages omitted; use --limit <n> or --all to show more.\n",
      );
      const timeline = stdout.slice(stdout.indexOf("timeline (last 20"));
      expect(timeline).not.toContain("prompt 01");
      expect(timeline).not.toContain("answer 01");
      expect(timeline).not.toContain("prompt 02");
      expect(timeline).not.toContain("answer 02");
      expect(timeline).toContain(
        "5. user msg_append-2026-02-02T00_00_03_000Z_1: prompt 03\n",
      );
      expect(stdout).toContain(
        "24. assistant msg_append-2026-02-02T00_00_12_000Z_2: answer 12\n",
      );
      expect(fixture.stderr()).toBe("");

      const equalsLimitFixture = createRuntime(
        ["sessions", "show", "bounded", "--limit=2"],
        {
          cwd: workspace,
          env: {
            KEEL_HOME: home,
          },
        },
      );
      const equalsLimitExitCode = await runCliMain(equalsLimitFixture.runtime);
      expect(equalsLimitExitCode).toBe(0);
      expect(equalsLimitFixture.stdout()).toContain(
        "timeline (last 2 of 24 messages):\n",
      );
      expect(equalsLimitFixture.stdout()).toContain(
        "23. user msg_append-2026-02-02T00_00_12_000Z_1: prompt 12\n",
      );
      expect(equalsLimitFixture.stdout()).toContain(
        "24. assistant msg_append-2026-02-02T00_00_12_000Z_2: answer 12\n",
      );
      expect(equalsLimitFixture.stderr()).toBe("");

      const spacedLimitFixture = createRuntime(
        ["sessions", "show", "bounded", "--limit", "3"],
        {
          cwd: workspace,
          env: {
            KEEL_HOME: home,
          },
        },
      );
      const spacedLimitExitCode = await runCliMain(spacedLimitFixture.runtime);
      expect(spacedLimitExitCode).toBe(0);
      expect(spacedLimitFixture.stdout()).toContain(
        "timeline (last 3 of 24 messages):\n",
      );
      expect(spacedLimitFixture.stdout()).toContain(
        "22. assistant msg_append-2026-02-02T00_00_11_000Z_2: answer 11\n",
      );
      expect(spacedLimitFixture.stdout()).toContain(
        "24. assistant msg_append-2026-02-02T00_00_12_000Z_2: answer 12\n",
      );
      expect(spacedLimitFixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
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
          {
            role: "user",
            content: longPrompt,
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered long prompt.",
            toolCalls: [],
          },
        ]),
        sessionTitleRecordLine("2026-01-04T00:00:06.000Z", "Fix login timeout"),
      ],
    });
    await writeSessionLedger({
      home,
      id: "older",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          {
            role: "user",
            content: "remember alpha",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered alpha.",
            toolCalls: [],
          },
        ]),
        appendSessionRecordLine("2026-01-01T00:00:06.000Z", [
          {
            role: "user",
            content: "remember alpha later",
            origin: { type: "user_prompt" },
          },
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
          {
            role: "user",
            content: "remember beta\nwith spacing",
            origin: { type: "user_prompt" },
          },
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
            {
              role: "user",
              content: `remember ${branchId}`,
              origin: { type: "user_prompt" },
            },
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
          {
            role: "user",
            content: "old compacted prompt",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Old compacted answer.",
            toolCalls: [],
          },
        ]),
        replaceSessionRecordLine("2026-01-01T18:00:02.000Z", [
          {
            role: "user",
            origin: { type: "compaction_checkpoint" },
            content: conversationCheckpoint("Old task summarized."),
          },
          {
            role: "user",
            content: "remember compacted",
            origin: { type: "user_prompt" },
          },
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
            origin: { type: "compaction_checkpoint" },
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
          {
            role: "user",
            content: "remember snapshot",
            origin: { type: "user_prompt" },
          },
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
          {
            role: "user",
            content: "remember tie a",
            origin: { type: "user_prompt" },
          },
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
          {
            role: "user",
            content: "remember tie b",
            origin: { type: "user_prompt" },
          },
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
          {
            role: "user",
            content: "do not show this session",
            origin: { type: "user_prompt" },
          },
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
      expect(stdout).toContain("resume latest: keel --resume\n");
      expect(stdout).toContain(
        "graph long-preview root long-preview  updated 2026-01-04T00:00:06.000Z\n",
      );
      expect(stdout).toContain(
        "long-preview  updated 2026-01-04T00:00:06.000Z\n",
      );
      expect(stdout).toContain("   branch: main\n");
      expect(stdout).toContain("   title: Fix login timeout\n");
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
          "     fork policy: transcript=copy_prefix, pendingInputs=drop, queuedInputs=drop",
          "     preview: remember branch-a",
          "     show: keel sessions show branch-a",
          "     resume: keel --resume branch-a",
          "     fork-points: keel --resume branch-a --fork-points",
          "     fork: keel sessions fork branch-a <new-id>",
          "     archive: keel sessions archive branch-a",
          "  branch-b  updated 2026-01-02T00:00:06.000Z",
        ].join("\n"),
      );
      expect(stdout).toContain("  forked  updated 2026-01-02T00:00:05.000Z\n");
      expect(stdout).toContain("     parent: older\n");
      expect(stdout).toContain("     preview: remember beta with spacing\n");
      expect(stdout).toContain(
        "     fork policy: transcript=copy_prefix, pendingInputs=drop, queuedInputs=drop\n",
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
      expect(stdout).toContain("   show: keel sessions show older\n");
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
          {
            role: "user",
            content: malformedCheckpoint,
            origin: { type: "user_prompt" },
          },
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
      id: "repo:test:review",
      packageId: "repo:test:review",
      digest: "digest",
      qualifiedName: "repo:review",
      scope: "repo" as const,
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
      skillState: skillState(workflowSkill),
      records: [
        appendSessionRecordLine("2026-01-01T00:00:01.000Z", [
          {
            role: "user",
            content: "review PR",
            origin: { type: "user_prompt" },
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "skilled-fork",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:02.000Z",
      skillState: skillState(workflowSkill),
      graph: endForkGraph({
        sessionId: "skilled-fork",
        parentSessionId: "skilled",
        sourceLastMessageId: "msg_append-2026-01-01T00_00_01_000Z_1",
        sourceOrdinal: 1,
      }),
      records: [
        appendSessionRecordLine("2026-01-01T00:00:03.000Z", [
          {
            role: "user",
            content: "continue review",
            origin: { type: "user_prompt" },
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
      expect(stdout).toContain(
        "   workflow skill: repo:review (.agents/skills/review/SKILL.md)\n",
      );
      expect(stdout).toContain(
        "     workflow skill: repo:review (.agents/skills/review/SKILL.md)\n",
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
          {
            role: "user",
            content: "remember good",
            origin: { type: "user_prompt" },
          },
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
