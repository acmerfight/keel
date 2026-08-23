import {
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
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  appendSessionRecordLine,
  ledgerRecordMessages,
  ledgerRecordStoredMessages,
  restoredUserMessageId,
  rootGraph,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";

describe("CLI Main - Session Fork", () => {
  test(`Given a named session has multiple completed prompts,
    When the user forks it before a restored user message,
    Then the fork continues from the earlier history only`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\nremember beta\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const betaMessageId = await restoredUserMessageId({
        home,
        sessionId: "source",
        content: "remember beta",
      });
      const forkInput = new PassThrough();
      forkInput.end("what did I ask you to remember?\n");
      const forkRun = createRuntime(
        [
          "--resume",
          "source",
          "--fork",
          "target",
          `--fork-before-message=${betaMessageId}`,
        ],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: forkInput,
        },
      );

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe("Earlier you said: remember alpha\n");
      expect(forkRun.stderr()).toBe("");
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        graph: { parentSessionId: "source" },
      });
      const forkedHistory = targetLedgerLines.find(
        (line) => line.type === "append",
      );
      expect(forkedHistory).toMatchObject({ type: "append" });
      expect(ledgerRecordMessages(forkedHistory)).toEqual([
        {
          role: "user",
          content: "remember alpha",
          origin: { type: "user_prompt" },
        },
        {
          role: "assistant",
          content: "Remembered: remember alpha",
          toolCalls: [],
        },
      ]);
      expect(JSON.stringify(forkedHistory)).not.toContain("remember beta");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed interactive session has multiple completed prompts,
    When the user enters /fork before a restored user message and continues chatting,
    Then the CLI creates the fork without switching the current session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\nremember beta\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const betaMessageId = await restoredUserMessageId({
        home,
        sessionId: "source",
        content: "remember beta",
      });
      const forkInput = new PassThrough();
      forkInput.end(
        `/fork target --before-message ${betaMessageId}\nremember gamma\n`,
      );
      const forkRun = createRuntime(["--resume", "source"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: forkInput,
      });

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe(
        [
          `Forked session "source" to "target" before message ${betaMessageId}.`,
          "resume: keel --resume target",
          "Remembered: remember gamma",
          "",
        ].join("\n"),
      );
      expect(forkRun.stderr()).toBe("");
      const sourceLedger = await readFile(
        join(home, "sessions", "source", "ledger.jsonl"),
        "utf8",
      );
      expect(sourceLedger).not.toContain("/fork");
      expect(sourceLedger).toContain("remember gamma");
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        graph: { parentSessionId: "source" },
      });
      const forkedHistory = targetLedgerLines.find(
        (line) => line.type === "append",
      );
      expect(forkedHistory).toMatchObject({ type: "append" });
      expect(ledgerRecordMessages(forkedHistory)).toEqual([
        {
          role: "user",
          content: "remember alpha",
          origin: { type: "user_prompt" },
        },
        {
          role: "assistant",
          content: "Remembered: remember alpha",
          toolCalls: [],
        },
      ]);
      expect(JSON.stringify(forkedHistory)).not.toContain("remember beta");
      expect(JSON.stringify(targetLedgerLines)).not.toContain("remember gamma");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed interactive session has multiple completed prompts,
    When the user lists fork points and picks one interactively,
    Then the CLI creates the selected fork without exposing commands to the model`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\nremember beta\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const alphaMessageId = await restoredUserMessageId({
        home,
        sessionId: "source",
        content: "remember alpha",
      });
      const betaMessageId = await restoredUserMessageId({
        home,
        sessionId: "source",
        content: "remember beta",
      });
      const forkInput = new PassThrough();
      forkInput.end("/fork-points\n/fork target --pick\n2\nremember gamma\n");
      const forkRun = createRuntime(["--resume", "source"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: forkInput,
      });

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe(
        [
          'Fork points for session "source":',
          `1. before message ${alphaMessageId}: remember alpha`,
          `   use: /fork <new-id> --before-message ${alphaMessageId}`,
          `2. before message ${betaMessageId}: remember beta`,
          `   use: /fork <new-id> --before-message ${betaMessageId}`,
          'Fork points for session "source":',
          "0. full restored history",
          `1. before message ${alphaMessageId}: remember alpha`,
          `2. before message ${betaMessageId}: remember beta`,
          "",
          "Select fork point [0-2], or q to cancel:",
          `Forked session "source" to "target" before message ${betaMessageId}.`,
          "resume: keel --resume target",
          "Remembered: remember gamma",
          "",
        ].join("\n"),
      );
      expect(forkRun.stderr()).toBe("");
      const sourceLedgerLines = (
        await readFile(join(home, "sessions", "source", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const sourceTranscriptRecords = sourceLedgerLines.filter((line) =>
        [
          "append",
          "replace",
          "task_admitted",
          "step_committed",
          "task_terminal",
        ].includes(line.type),
      );
      const sourceUserMessages = sourceTranscriptRecords
        .flatMap(ledgerRecordMessages)
        .flatMap((message) =>
          message?.role === "user" ? [message.content] : [],
        );
      expect(sourceUserMessages).not.toContain("/fork-points");
      expect(sourceUserMessages).not.toContain("/fork target --pick");
      expect(sourceUserMessages).not.toContain("2");
      expect(JSON.stringify(sourceTranscriptRecords)).toContain(
        "remember gamma",
      );
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        graph: { parentSessionId: "source" },
      });
      const forkedHistory = targetLedgerLines.find(
        (line) => line.type === "append",
      );
      expect(forkedHistory).toMatchObject({ type: "append" });
      expect(ledgerRecordMessages(forkedHistory)).toEqual([
        {
          role: "user",
          content: "remember alpha",
          origin: { type: "user_prompt" },
        },
        {
          role: "assistant",
          content: "Remembered: remember alpha",
          toolCalls: [],
        },
      ]);
      expect(JSON.stringify(forkedHistory)).not.toContain("remember beta");
      expect(JSON.stringify(targetLedgerLines)).not.toContain("remember gamma");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed interactive session has completed history,
    When the user enters /fork without a fork point and continues chatting,
    Then the CLI creates a full-history fork without switching the current session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const forkInput = new PassThrough();
      forkInput.end("/fork target\nremember gamma\n");
      const forkRun = createRuntime(["--resume", "source"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: forkInput,
      });

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe(
        [
          'Forked session "source" to "target".',
          "resume: keel --resume target",
          "Remembered: remember gamma",
          "",
        ].join("\n"),
      );
      expect(forkRun.stderr()).toBe("");
      const sourceLedger = await readFile(
        join(home, "sessions", "source", "ledger.jsonl"),
        "utf8",
      );
      expect(sourceLedger).not.toContain("/fork");
      expect(sourceLedger).toContain("remember gamma");
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        graph: { parentSessionId: "source" },
      });
      const forkedHistory = targetLedgerLines.find(
        (line) => line.type === "append",
      );
      expect(forkedHistory).toMatchObject({ type: "append" });
      expect(ledgerRecordMessages(forkedHistory)).toEqual([
        {
          role: "user",
          content: "remember alpha",
          origin: { type: "user_prompt" },
        },
        {
          role: "assistant",
          content: "Remembered: remember alpha",
          toolCalls: [],
        },
      ]);
      expect(JSON.stringify(targetLedgerLines)).not.toContain("remember gamma");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed interactive session fork target already exists,
    When the user enters /fork and continues chatting,
    Then the CLI reports the fork error without switching the current session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember source\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });
    const targetInput = new PassThrough();
    targetInput.end("remember target\n");
    const targetRun = createRuntime(["--session", "target"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: targetInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const targetExitCode = await runCliMain(targetRun.runtime);
      const targetLedgerPath = join(home, "sessions", "target", "ledger.jsonl");
      const targetLedgerBefore = await readFile(targetLedgerPath, "utf8");
      const forkInput = new PassThrough();
      forkInput.end("/fork target\nremember gamma\n");
      const forkRun = createRuntime(["--resume", "source"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: forkInput,
      });

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(targetExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe("Remembered: remember gamma\n");
      expect(forkRun.stderr()).toBe(
        'Error: session "target" already exists. Use --resume target to continue it.\n',
      );
      const sourceLedger = await readFile(
        join(home, "sessions", "source", "ledger.jsonl"),
        "utf8",
      );
      expect(sourceLedger).not.toContain("/fork");
      expect(sourceLedger).toContain("remember gamma");
      expect(await readFile(targetLedgerPath, "utf8")).toBe(targetLedgerBefore);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a fork command is queued behind an interactive prompt,
    When the queued fork command is processed,
    Then the CLI marks it consumed without sending it to the model`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember source\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });
    const targetInput = new PassThrough();
    targetInput.end("remember target\n");
    const targetRun = createRuntime(["--session", "target"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: targetInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const targetExitCode = await runCliMain(targetRun.runtime);
      const targetLedgerPath = join(home, "sessions", "target", "ledger.jsonl");
      const targetLedgerBefore = await readFile(targetLedgerPath, "utf8");
      const forkInput = new PassThrough();
      forkInput.end("remember gamma\n/fork target\nremember delta\n");
      const forkRun = createRuntime(["--resume", "source"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: forkInput,
      });

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(targetExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe(
        "Remembered: remember gamma\nRemembered: remember delta\n",
      );
      expect(forkRun.stderr()).toBe(
        'Error: session "target" already exists. Use --resume target to continue it.\n',
      );
      expect(await readFile(targetLedgerPath, "utf8")).toBe(targetLedgerBefore);
      const sourceLedgerLines = (
        await readFile(join(home, "sessions", "source", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const admittedForkInput = sourceLedgerLines.find(
        (line) =>
          line.type === "input_admitted" && line.line === "/fork target",
      );
      expect(admittedForkInput).toBeDefined();
      expect(sourceLedgerLines).toContainEqual(
        expect.objectContaining({
          type: "input_consumed",
          inputIds: [admittedForkInput.id],
        }),
      );
      const sourceAppends = sourceLedgerLines.filter(
        (line) => line.type === "append",
      );
      expect(JSON.stringify(sourceAppends)).not.toContain("/fork target");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has multiple completed prompts,
    When the user creates a fork with the sessions command,
    Then the CLI creates an independent target without starting an agent`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\nremember beta\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });
    const listRun = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const betaMessageId = await restoredUserMessageId({
        home,
        sessionId: "source",
        content: "remember beta",
      });
      const forkRun = createRuntime(
        [
          "sessions",
          "fork",
          "source",
          "target",
          `--before-message=${betaMessageId}`,
        ],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "deepseek",
            KEEL_HOME: home,
          },
        },
      );

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);
      const listExitCode = await runCliMain(listRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe(
        [
          `Forked session "source" to "target" before message ${betaMessageId}.`,
          "resume: keel --resume target",
          "",
        ].join("\n"),
      );
      expect(forkRun.stderr()).toBe("");
      expect(listExitCode).toBe(0);
      expect(listRun.stdout()).toContain("target  updated ");
      expect(listRun.stdout()).toContain("     parent: source\n");
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        graph: { parentSessionId: "source" },
      });
      const forkedHistory = targetLedgerLines.find(
        (line) => line.type === "append",
      );
      expect(forkedHistory).toMatchObject({ type: "append" });
      expect(ledgerRecordMessages(forkedHistory)).toEqual([
        {
          role: "user",
          content: "remember alpha",
          origin: { type: "user_prompt" },
        },
        {
          role: "assistant",
          content: "Remembered: remember alpha",
          toolCalls: [],
        },
      ]);
      expect(JSON.stringify(forkedHistory)).not.toContain("remember beta");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has completed history,
    When the user creates a full fork with the sessions command,
    Then the CLI copies the restored history and prints the resume command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "source",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:01.000Z", [
          {
            role: "user",
            content: "remember alpha",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered: remember alpha",
            toolCalls: [],
          },
        ]),
      ],
    });
    const forkRun = createRuntime(["sessions", "fork", "source", "target"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "deepseek",
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe(
        [
          'Forked session "source" to "target".',
          "resume: keel --resume target",
          "",
        ].join("\n"),
      );
      expect(forkRun.stderr()).toBe("");
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        graph: { parentSessionId: "source" },
      });
      const forkedHistory = targetLedgerLines.find(
        (line) => line.type === "append",
      );
      expect(ledgerRecordMessages(forkedHistory)).toEqual([
        {
          role: "user",
          content: "remember alpha",
          origin: { type: "user_prompt" },
        },
        {
          role: "assistant",
          content: "Remembered: remember alpha",
          toolCalls: [],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has multiple completed prompts,
    When the user lists fork points for that session,
    Then the CLI shows the restored user message numbers and matching fork commands`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const longPrompt = `remember ${"0123456789".repeat(14)}`;
    const longPromptPreview = `${longPrompt.slice(0, 117)}...`;
    const sourceInput = new PassThrough();
    sourceInput.end(`remember alpha\n${longPrompt}\n`);
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });
    const listRun = createRuntime(["--resume", "source", "--fork-points"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const alphaMessageId = await restoredUserMessageId({
        home,
        sessionId: "source",
        content: "remember alpha",
      });
      const longPromptMessageId = await restoredUserMessageId({
        home,
        sessionId: "source",
        content: longPrompt,
      });

      // When
      const listExitCode = await runCliMain(listRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(listExitCode).toBe(0);
      expect(listRun.stdout()).toBe(
        [
          'Fork points for session "source":',
          `1. message ${alphaMessageId}: remember alpha`,
          `   use: keel sessions fork source <new-id> --before-message ${alphaMessageId}`,
          `2. message ${longPromptMessageId}: ${longPromptPreview}`,
          `   use: keel sessions fork source <new-id> --before-message ${longPromptMessageId}`,
          "",
        ].join("\n"),
      );
      expect(listRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has multiple completed prompts,
    When the user lists fork points for that session,
    Then the CLI shows stable restored message ids and matching fork commands`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\nremember beta\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });
    const listRun = createRuntime(["--resume", "source", "--fork-points"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const sourceLedgerLines = (
        await readFile(join(home, "sessions", "source", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const storedMessages = sourceLedgerLines.flatMap(
        ledgerRecordStoredMessages,
      );
      const alphaMessage = storedMessages.find(
        (storedMessage) =>
          storedMessage.message?.role === "user" &&
          storedMessage.message.content === "remember alpha",
      );
      const betaMessage = storedMessages.find(
        (storedMessage) =>
          storedMessage.message?.role === "user" &&
          storedMessage.message.content === "remember beta",
      );
      if (
        typeof alphaMessage?.id !== "string" ||
        typeof betaMessage?.id !== "string"
      ) {
        throw new Error("expected source ledger to store user message ids");
      }

      // When
      const listExitCode = await runCliMain(listRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(listExitCode).toBe(0);
      expect(listRun.stdout()).toBe(
        [
          'Fork points for session "source":',
          `1. message ${alphaMessage.id}: remember alpha`,
          `   use: keel sessions fork source <new-id> --before-message ${alphaMessage.id}`,
          `2. message ${betaMessage.id}: remember beta`,
          `   use: keel sessions fork source <new-id> --before-message ${betaMessage.id}`,
          "",
        ].join("\n"),
      );
      expect(listRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session contains unsafe terminal bytes,
    When the user lists fork points for that session,
    Then the CLI escapes the preview bytes before printing them`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "source",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:01.000Z", [
          {
            role: "user",
            content: "remember \u001b[2J hidden\u202e marker",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered unsafe bytes",
            toolCalls: [],
          },
        ]),
      ],
    });
    const unsafeMessageId = await restoredUserMessageId({
      home,
      sessionId: "source",
      content: "remember \u001b[2J hidden\u202e marker",
    });
    const listRun = createRuntime(["--resume", "source", "--fork-points"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const listExitCode = await runCliMain(listRun.runtime);

      // Then
      expect(listExitCode).toBe(0);
      expect(listRun.stdout()).toBe(
        [
          'Fork points for session "source":',
          `1. message ${unsafeMessageId}: remember \\x1b[2J hidden\\u{202e} marker`,
          `   use: keel sessions fork source <new-id> --before-message ${unsafeMessageId}`,
          "",
        ].join("\n"),
      );
      expect(listRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has no restored user messages,
    When the user lists fork points for that session,
    Then the CLI reports that no fork points are available`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionDir = join(home, "sessions", "empty");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "ledger.jsonl"),
      `${JSON.stringify({
        schemaVersion: 11,
        type: "session",
        id: "empty",
        createdAt: "1970-01-01T00:00:00.000Z",
        workspace: await realpath(workspace),
        graph: rootGraph("empty"),
      })}\n`,
      "utf8",
    );
    const listRun = createRuntime(["--resume", "empty", "--fork-points"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const listExitCode = await runCliMain(listRun.runtime);

      // Then
      expect(listExitCode).toBe(0);
      expect(listRun.stdout()).toBe(
        'No restored user messages in session "empty".\n',
      );
      expect(listRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
