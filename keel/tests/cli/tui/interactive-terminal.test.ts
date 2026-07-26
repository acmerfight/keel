import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Terminal } from "@earendil-works/pi-tui";
import xtermHeadless from "@xterm/headless";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createPromptedBashPermissionPolicy } from "../../../src/cli/interactive-session/bash-approval.ts";
import type { InteractiveDiffInspection } from "../../../src/cli/interactive-session/diff-inspection.ts";
import { createLineReader } from "../../../src/cli/interactive-session/line-reader.ts";
import { diffReviewRange } from "../../../src/cli/tui/diff-review-state.ts";
import { createInteractiveTerminalDisplay } from "../../../src/cli/tui/interactive-terminal.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
} from "../../../src/testing/provider-sse-fixtures.ts";
import { parseGitDiffOutput } from "../../../src/tools/git-diff-document.ts";

class TestTerminal implements Terminal {
  private readonly screen: InstanceType<typeof xtermHeadless.Terminal>;
  private inputHandler: ((data: string) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private writes = Promise.resolve();
  columns: number;
  rows: number;
  readonly kittyProtocolActive = false;
  stopCount = 0;

  constructor(columns = 100, rows = 30) {
    this.columns = columns;
    this.rows = rows;
    this.screen = new xtermHeadless.Terminal({
      cols: columns,
      rows,
      scrollback: 5_000,
      allowProposedApi: true,
    });
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
  }

  stop(): void {
    this.stopCount++;
    this.inputHandler = null;
    this.resizeHandler = null;
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.writes = this.writes.then(
      () =>
        new Promise<void>((resolve) => {
          this.screen.write(data, resolve);
        }),
    );
  }

  moveBy(lines: number): void {
    if (lines < 0) {
      this.write(`\x1b[${-lines}A`);
    } else if (lines > 0) {
      this.write(`\x1b[${lines}B`);
    }
  }

  hideCursor(): void {
    this.write("\x1b[?25l");
  }

  showCursor(): void {
    this.write("\x1b[?25h");
  }

  clearLine(): void {
    this.write("\x1b[2K\r");
  }

  clearFromCursor(): void {
    this.write("\x1b[0J");
  }

  clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }

  setTitle(_title: string): void {}

  setProgress(_active: boolean): void {}

  input(data: string): void {
    this.inputHandler?.(data);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.screen.resize(columns, rows);
    this.resizeHandler?.();
  }

  async text(): Promise<string> {
    await this.writes;
    const buffer = this.screen.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  async waitForText(text: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const screen = await this.text();
      if (screen.includes(text)) {
        return screen;
      }
      await delay(5);
    }
    throw new Error(`terminal did not render ${text}`);
  }
}

describe("Interactive Terminal Display", () => {
  test(`Given a diff review has no semantic rows,
    When its independent viewport state is projected,
    Then the range reports an exact empty position`, () => {
    expect(
      diffReviewRange(
        { kind: "at-top" },
        {
          totalRows: 0,
          visibleRows: 12,
        },
      ),
    ).toEqual({
      scrollTop: 0,
      lineFrom: 0,
      lineTo: 0,
    });
  });

  test(`Given the TUI receives the authoritative workflow skill catalog,
    When the user types a /skill argument prefix,
    Then autocomplete shows the qualified catalog identity`, async () => {
    // Given
    const terminal = new TestTerminal();
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
      colorMode: "plain",
      session: { kind: "ephemeral" },
      workspace: process.cwd(),
      skillCompletions: [
        {
          id: "user:test:review",
          packageId: "user:test:review",
          rootKey: "test",
          rootPriority: 1000,
          qualifiedName: "user:review",
          scope: "user",
          activationPolicy: "implicit",
          name: "review",
          description: "Review using the user's workflow.",
          relativePath: "~/.agents/skills/review/SKILL.md",
          digest: "digest",
        },
      ],
      onInterrupt: () => {},
    });
    display.start();

    // When
    terminal.input("/skill user");

    // Then
    const screen = await terminal.waitForText("user:review");
    expect(screen).toContain("Review using the user's workflow.");
    terminal.input(" review");
    display.stop();
  });

  test(`Given the TUI has no Skill completions,
    When the user types an unmatched /skill prefix,
    Then autocomplete handles the empty authoritative catalog`, () => {
    const terminal = new TestTerminal();
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
      colorMode: "plain",
      session: { kind: "ephemeral" },
      workspace: process.cwd(),
      onInterrupt: () => {},
    });
    display.start();

    terminal.input("/skill missing");

    display.stop();
  });

  test(`Given the CLI runs with a real terminal display,
    When the user submits a bracketed multiline paste and interrupts at the next prompt,
    Then the terminal renders one reply and restores terminal state`, async () => {
    // Given
    const input = new PassThrough();
    const terminal = new TestTerminal();
    const fixture = createRuntime(["--ephemeral"], {
      env: { KEEL_PROVIDER: "fake", NO_COLOR: "1" },
      input,
      inputIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
      createInteractiveTerminal: () => terminal,
    });
    const run = runCliMain(fixture.runtime);
    await terminal.waitForText("keel>");

    // When
    terminal.input("\r");
    terminal.input("\x1b[200~alpha\nbeta\x1b[201~");
    terminal.input("\r");
    const screen = await terminal.waitForText("Remembered: alpha");
    terminal.input("\x03");

    // Then
    await expect(run).resolves.toBe(130);
    expect(screen).toContain("beta");
    expect(terminal.stopCount).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the CLI runs with --no-skills in a real terminal,
    When the terminal initializes Skill completion and the user requests activation,
    Then it uses an empty completion catalog and reports the per-run disable`, async () => {
    // Given
    const terminal = new TestTerminal();
    const fixture = createRuntime(["--ephemeral", "--no-skills"], {
      env: { KEEL_PROVIDER: "fake" },
      input: new PassThrough(),
      inputIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
      createInteractiveTerminal: () => terminal,
    });
    const run = runCliMain(fixture.runtime);
    await terminal.waitForText("keel>");

    // When
    terminal.input("/skill review");
    terminal.input("\r");

    // Then
    const screen = await terminal.waitForText(
      "workflow skills are disabled for this run by --no-skills",
    );
    expect(screen).not.toContain("repo:review");
    terminal.input("\x03");
    await expect(run).resolves.toBe(130);
    expect(terminal.stopCount).toBe(1);
  });

  test(`Given a terminal display receives transcript and status output,
    When it starts and later closes twice through normal cleanup,
    Then it renders every output class and closes its input once`, async () => {
    // Given
    const terminal = new TestTerminal();
    let closedCount = 0;
    let interrupted = 0;
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
      colorMode: "plain",
      session: { kind: "ephemeral" },
      onInterrupt: () => {
        interrupted++;
      },
    });
    display.lineInput.once("close", () => {
      closedCount++;
    });
    display.setActivityStatus("Preparing");
    display.setGoalStatus("active - Verify terminal status");
    display.writeIntro();
    display.start();

    // When
    display.writeStderr("notice\n");
    display.renderAgentEvent({
      type: "assistant_delta",
      text: "answer\n",
    });
    display.renderAgentEvent({
      type: "notice",
      tone: "info",
      text: "working",
    });
    display.renderPrompt();
    display.acceptInput();
    terminal.input("\x03");
    terminal.input("draft");
    terminal.input("\x04");
    expect(closedCount).toBe(0);
    terminal.input("\x15");
    terminal.input("\x04");
    const screen = await terminal.waitForText("· working");
    display.setActivityStatus(null);
    display.setGoalStatus(null);
    display.closePrompt();
    display.stop();

    // Then
    expect(screen).toContain("notice");
    expect(screen).toContain("answer");
    expect(screen).toContain("◦ Preparing");
    expect(screen).toContain("◎ active - Verify terminal status");
    expect(interrupted).toBe(1);
    expect(closedCount).toBe(1);
    expect(terminal.stopCount).toBe(1);
  });

  test(`Given the diff viewer receives a semantic change document,
    When the user navigates, resizes, and closes it,
    Then the actual headless terminal renders every audit variant and restores input`, async () => {
    const diff = [
      "Git emitted an informational prelude.",
      "Unstaged changes:",
      "diff --git a/modified.txt b/modified.txt",
      "index 1111111..2222222 100644",
      "--- a/modified.txt",
      "+++ b/modified.txt",
      "@@ -1,2 +1,2 @@",
      "-before",
      "+after",
      " context",
      "[git_diff output truncated: inspect a narrower path.]",
      "",
      "Staged changes:",
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1 @@",
      "+added",
      "diff --git a/deleted.txt b/deleted.txt",
      "deleted file mode 100644",
      "--- a/deleted.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-deleted",
      "diff --git a/old.txt b/renamed.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to renamed.txt",
      "diff --git a/source.txt b/copied.txt",
      "similarity index 100%",
      "copy from source.txt",
      "copy to copied.txt",
      "diff --git a/mode.txt b/mode.txt",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/data.bin b/data.bin",
      "index 1111111..2222222 100644",
      "Binary files a/data.bin and b/data.bin differ",
      "",
      'Untracked changes ("新文件.txt"):',
      'diff --git "a/新文件.txt" "b/新文件.txt"',
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      '+++ "b/新文件.txt"',
      "@@ -0,0 +1 @@",
      "+新增",
      "",
      "Ref comparison (main -> topic):",
      "diff --cc conflict.txt",
      "index 1111111,2222222..3333333",
      "--- a/conflict.txt",
      "+++ b/conflict.txt",
      "@@@ -1,1 -1,1 +1,5 @@@",
      "++<<<<<<< HEAD",
      "+ main",
      " +other",
      "++>>>>>>> topic",
    ].join("\n");
    const inspection: InteractiveDiffInspection = {
      kind: "changes",
      statusOutput: "Branch: main",
      plainDiffOutput: diff,
      document: parseGitDiffOutput(diff, true),
    };
    const terminal = new TestTerminal(100, 24);
    const submitted: string[] = [];
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
      colorMode: "plain",
      session: { kind: "ephemeral" },
      onInterrupt: () => {},
    });
    display.lineInput.on("line", (line) => {
      submitted.push(line);
    });
    display.start();

    display.renderDiffReview(inspection);
    display.renderDiffReview(inspection);
    const first = await terminal.waitForText("Workspace changes");
    expect(first).toContain("9 files");
    expect(first).toContain("1 conflict");
    expect(first).toContain("M modified.txt");
    expect(first).toContain("PgUp/PgDn");

    for (const key of [
      "\x1b[B",
      "\x1b[A",
      "\x1b[6~",
      "\x1b[5~",
      "\x1b[F",
      "\x1b[B",
      "\x1b[H",
      "x",
    ]) {
      terminal.input(key);
    }
    terminal.resize(42, 18);
    const narrow = await terminal.waitForText("Esc/q close");
    expect(narrow).toContain("PgUp/PgDn");
    expect(narrow).toContain("Home/End");

    terminal.input("\x1b[113u");
    terminal.input("resumed");
    terminal.input("\r");
    expect(submitted).toEqual(["resumed"]);
    display.stop();
  });

  test(`Given clean, non-Git, and failed diff inspections,
    When each opens in the focused viewer,
    Then the actual headless terminal makes every state explicit and closable`, async () => {
    const scenarios: readonly {
      readonly inspection: InteractiveDiffInspection;
      readonly expected: string;
      readonly close: string;
    }[] = [
      {
        inspection: {
          kind: "clean",
          statusOutput: "Branch: main\nNo git changes found.",
        },
        expected: "Working tree is clean",
        close: "q",
      },
      {
        inspection: {
          kind: "non-git",
          message: "Not in a Git work tree.",
        },
        expected: "Not a Git repository",
        close: "\x1b",
      },
      {
        inspection: {
          kind: "failed",
          message: "Error: git is unavailable",
        },
        expected: "Could not load changes",
        close: "Q",
      },
    ];

    for (const scenario of scenarios) {
      const terminal = new TestTerminal(64, 16);
      const display = createInteractiveTerminalDisplay(terminal, {
        inputEchoesToDisplay: true,
        colorMode: "plain",
        session: { kind: "ephemeral" },
        onInterrupt: () => {},
      });
      display.start();
      display.renderDiffReview(scenario.inspection);

      const screen = await terminal.waitForText(scenario.expected);
      expect(screen).toContain("Esc/q");
      terminal.input(scenario.close);
      display.stop();
    }
  });

  test(`Given complete, empty, and multiply-conflicted semantic documents,
    When each is rendered in the actual headless terminal,
    Then summaries, fallback content, scope, and narrow footer remain explicit`, async () => {
    const completeDiff = [
      "diff --git a/only.txt b/only.txt",
      "index 1111111..2222222 100644",
      "--- a/only.txt",
      "+++ b/only.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");
    const conflicts = [
      "Ref comparison (main -> topic):",
      "diff --cc first.txt",
      "index 1111111,2222222..3333333",
      "diff --cc second.txt",
      "index 4444444,5555555..6666666",
    ].join("\n");
    const scenarios: readonly {
      readonly inspection: InteractiveDiffInspection;
      readonly expected: readonly string[];
    }[] = [
      {
        inspection: {
          kind: "changes",
          statusOutput: "Branch: main",
          plainDiffOutput: completeDiff,
          document: parseGitDiffOutput(completeDiff, false),
        },
        expected: [
          "1 file",
          "Changes",
          "Current workspace · staged, unstaged, and untracked",
        ],
      },
      {
        inspection: {
          kind: "changes",
          statusOutput: "Branch: main",
          plainDiffOutput: "",
          document: parseGitDiffOutput("", false),
        },
        expected: ["0 files", "No reviewable file changes."],
      },
      {
        inspection: {
          kind: "changes",
          statusOutput: "Branch: main",
          plainDiffOutput: conflicts,
          document: parseGitDiffOutput(conflicts, false),
        },
        expected: [
          "2 files · 2 conflicts",
          "Ref comparison (main -> topic)",
          "CONFLICT first.txt",
          "CONFLICT second.txt",
        ],
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const terminal = new TestTerminal(64, 16);
      const display = createInteractiveTerminalDisplay(terminal, {
        inputEchoesToDisplay: true,
        colorMode: "plain",
        session: { kind: "ephemeral" },
        onInterrupt: () => {},
      });
      display.start();
      display.renderDiffReview(scenario.inspection);

      let screen = await terminal.waitForText(scenario.expected[0] ?? "");
      for (const expected of scenario.expected) {
        expect(screen).toContain(expected);
      }
      if (index === 0) {
        terminal.resize(18, 10);
        await delay(25);
        screen = await terminal.text();
        expect(screen).toContain("Esc/q");
      }
      terminal.input("q");
      display.stop();
    }
  });

  test(`Given two running tools have the same label and distinct call IDs,
    When their completion events arrive in reverse order,
    Then each audit row settles by call ID`, async () => {
    // Given
    const terminal = new TestTerminal();
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
      colorMode: "plain",
      session: { kind: "ephemeral" },
      onInterrupt: () => {},
    });
    display.start();
    display.renderAgentEvent({
      type: "tool_started",
      toolCallId: "first",
      label: "read same.md",
    });
    display.renderAgentEvent({
      type: "tool_started",
      toolCallId: "second",
      label: "read same.md",
    });

    // When
    display.renderAgentEvent({
      type: "tool_succeeded",
      toolCallId: "second",
      label: "read same.md",
    });
    display.renderAgentEvent({
      type: "tool_failed",
      toolCallId: "first",
      label: "read same.md",
    });

    // Then
    const screen = await terminal.waitForText("✗ read same.md");
    expect(screen.match(/✓ read same\.md/gu)).toHaveLength(1);
    expect(screen.match(/✗ read same\.md/gu)).toHaveLength(1);
    expect(screen).not.toContain("◦ read same.md");
    display.stop();
  });

  test(`Given the composer has submitted history and an unsent draft,
    When the user browses older entries and returns to the draft,
    Then Keel restores the draft cursor and keeps duplicate history entries collapsed`, async () => {
    // Given
    const terminal = new TestTerminal();
    const submitted: string[] = [];
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
      colorMode: "plain",
      session: { kind: "ephemeral" },
      onInterrupt: () => {},
    });
    display.lineInput.on("line", (line) => {
      submitted.push(line);
    });
    display.start();
    terminal.input("\x1b[A");
    terminal.input("first");
    terminal.input("\r");
    terminal.input("second");
    terminal.input("\r");
    terminal.input("second");
    terminal.input("\r");
    terminal.input("draft tail");
    for (let index = 0; index < 5; index++) {
      terminal.input("\x1b[D");
    }

    // When
    terminal.input("\x1b[A");
    terminal.input("\x1b[A");
    terminal.input("\x1b[A");
    terminal.input("\x1b[B");
    terminal.input("\x1b[B");
    terminal.input(" restored");
    terminal.input("\r");
    terminal.input("\x1b[A");
    terminal.input("!");
    terminal.input("\x1b[B");
    terminal.input("\r");
    terminal.input("\x1b[200~multi\nline\x1b[201~");
    terminal.input("\x1b[A");

    // Then
    expect(submitted).toEqual([
      "first",
      "second",
      "second",
      "draft restored tail",
      "draft restored tail!",
    ]);
    const screen = await terminal.waitForText("multi");
    expect(screen).toContain("line");
    display.stop();
  });

  test(`Given the runtime changes how submitted input will be consumed,
    When the composer moves through steering, queue, approval, and ready modes,
    Then each disposition and its guidance are visible before submission`, async () => {
    // Given
    const terminal = new TestTerminal();
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
      colorMode: "plain",
      session: { kind: "ephemeral" },
      onInterrupt: () => {},
    });
    const submittedDispositions = [
      "steer/next",
      "queue",
      "queue",
      "approve",
      "keel",
    ] as const;
    let submittedIndex = 0;
    display.lineInput.on("line", (line) => {
      const disposition = submittedDispositions[submittedIndex];
      if (disposition === undefined) {
        throw new Error("unexpected submitted input");
      }
      submittedIndex++;
      display.renderSubmittedInput(line, disposition);
    });
    display.setComposerMode("queue");
    display.start();
    const initialQueue = await terminal.waitForText(
      "current operation finishes",
    );
    expect(initialQueue).toContain("queue>");

    // When / Then: steering
    display.setComposerMode("steer");
    const steering = await terminal.waitForText("runs next");
    expect(steering).toContain("steer/next>");
    terminal.input("guide this turn");
    terminal.input("\r");
    terminal.input("/status");
    terminal.input("\r");

    // When / Then: operation queue
    display.setComposerMode("queue");
    const queued = await terminal.waitForText("current operation finishes");
    expect(queued).toContain("queue>");
    terminal.input("\x1b[200~after\ncompaction\x1b[201~");
    terminal.input("\r");

    // When / Then: approval response
    display.setComposerMode("approval");
    const approval = await terminal.waitForText("any other input denies");
    expect(approval).toContain("approve>");
    terminal.input("y");
    terminal.input("\r");

    // When / Then: ordinary prompt
    display.setComposerMode("ready");
    terminal.input("/help");
    terminal.input("\r");
    const ready = await terminal.waitForText("› /help");
    expect(ready).toContain("› [steer] guide this turn");
    expect(ready).toContain("› [queued] /status");
    expect(ready).toContain("› [queued] after");
    expect(ready).toContain("  compaction");
    expect(ready).toContain("› [approval] y");
    expect(ready).toContain("keel>");
    display.stop();
  });

  test(`Given bash approval is waiting in the real TUI composer,
    When the user presses Enter without an answer,
    Then the empty response reaches the approval policy and denies the command`, async () => {
    // Given
    const terminal = new TestTerminal();
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
      colorMode: "plain",
      session: { kind: "ephemeral" },
      onInterrupt: () => {},
    });
    const lineReader = createLineReader(display.lineInput, {});
    const policy = createPromptedBashPermissionPolicy(
      lineReader,
      display.writeStderr,
      {
        scopeLabel: "session",
        onPromptStart: () => {
          display.setComposerMode("approval");
        },
        onPromptEnd: () => {
          display.setComposerMode("steer");
        },
      },
    );
    display.start();
    const decision = policy.review({
      command: "pwd",
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    await terminal.waitForText("approve>");

    // When
    terminal.input("\r");

    // Then
    await expect(decision).resolves.toEqual({
      type: "deny",
      message: "No approval response provided.",
    });
    const screen = await terminal.waitForText("approve>");
    expect(screen).toContain("Approve bash command?");
    display.stop();
  });

  test(`Given a real terminal provider turn is still streaming,
    When the user interrupts twice,
    Then Keel restores terminal state before forcing the process to exit`, async () => {
    // Given
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`,
      );
    });
    await listen(server);
    const terminal = new TestTerminal();
    const fixture = createRuntime(["--ephemeral"], {
      env: {
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input: new PassThrough(),
      inputIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
      createInteractiveTerminal: () => terminal,
    });

    try {
      void runCliMain(fixture.runtime);
      await terminal.waitForText("keel>");
      terminal.input("start");
      terminal.input("\r");
      await terminal.waitForText("working");

      // When
      terminal.input("\x03");

      // Then
      expect(() => terminal.input("\x03")).toThrow("unexpected forceExit(130)");
      expect(terminal.stopCount).toBe(1);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});
