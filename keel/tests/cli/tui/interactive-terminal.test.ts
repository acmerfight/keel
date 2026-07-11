import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Terminal } from "@earendil-works/pi-tui";
import xtermHeadless from "@xterm/headless";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createPromptedBashPermissionPolicy } from "../../../src/cli/interactive-session/bash-approval.ts";
import { createLineReader } from "../../../src/cli/interactive-session/line-reader.ts";
import { createInteractiveTerminalDisplay } from "../../../src/cli/tui/interactive-terminal.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
} from "../../../src/testing/provider-sse-fixtures.ts";

class TestTerminal implements Terminal {
  private readonly screen = new xtermHeadless.Terminal({
    cols: 100,
    rows: 30,
    scrollback: 5_000,
    allowProposedApi: true,
  });
  private inputHandler: ((data: string) => void) | null = null;
  private writes = Promise.resolve();
  readonly columns = 100;
  readonly rows = 30;
  readonly kittyProtocolActive = false;
  stopCount = 0;

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.inputHandler = onInput;
  }

  stop(): void {
    this.stopCount++;
    this.inputHandler = null;
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
  test(`Given the CLI runs with a real terminal display,
    When the user submits a bracketed multiline paste and interrupts at the next prompt,
    Then the terminal renders one reply and restores terminal state`, async () => {
    // Given
    const input = new PassThrough();
    const terminal = new TestTerminal();
    const fixture = createRuntime(["--ephemeral"], {
      env: { KEEL_PROVIDER: "fake" },
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

  test(`Given a terminal display receives transcript and status output,
    When it starts and later closes twice through normal cleanup,
    Then it renders every output class and closes its input once`, async () => {
    // Given
    const terminal = new TestTerminal();
    let closedCount = 0;
    let interrupted = 0;
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
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
    display.writeAssistantHeader();
    display.writeStdout("answer\n");
    display.writeStatusLine("working");
    display.renderPrompt();
    display.acceptInput();
    terminal.input("\x03");
    terminal.input("draft");
    terminal.input("\x04");
    expect(closedCount).toBe(0);
    terminal.input("\x15");
    terminal.input("\x04");
    const screen = await terminal.waitForText("status: working");
    display.setActivityStatus(null);
    display.setGoalStatus(null);
    display.closePrompt();
    display.stop();

    // Then
    expect(screen).toContain("notice");
    expect(screen).toContain("assistant:");
    expect(screen).toContain("answer");
    expect(screen).toContain("activity: Preparing");
    expect(screen).toContain("goal · active - Verify terminal status");
    expect(interrupted).toBe(1);
    expect(closedCount).toBe(1);
    expect(terminal.stopCount).toBe(1);
  });

  test(`Given the composer has submitted history and an unsent draft,
    When the user browses older entries and returns to the draft,
    Then Keel restores the draft cursor and keeps duplicate history entries collapsed`, async () => {
    // Given
    const terminal = new TestTerminal();
    const submitted: string[] = [];
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
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
    const ready = await terminal.waitForText("keel> /help");
    expect(ready).toContain("steer/next> guide this turn");
    expect(ready).toContain("queue> /status");
    expect(ready).toContain("queue> after");
    expect(ready).toContain("       compaction");
    expect(ready).toContain("approve> y");
    display.stop();
  });

  test(`Given bash approval is waiting in the real TUI composer,
    When the user presses Enter without an answer,
    Then the empty response reaches the approval policy and denies the command`, async () => {
    // Given
    const terminal = new TestTerminal();
    const display = createInteractiveTerminalDisplay(terminal, {
      inputEchoesToDisplay: true,
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
