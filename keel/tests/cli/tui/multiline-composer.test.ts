import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resumeSessionStore } from "../../../src/cli/session-store.ts";
import { runCliPty } from "../../../src/testing/cli-pty-harness.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
} from "../../../src/testing/provider-sse-fixtures.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

describe("Interactive TUI Composer", () => {
  test(`Given an assistant turn is still running,
    When the user submits guidance and a slash command,
    Then the composer distinguishes steering from a queued command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tui-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-tui-home-"));
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
    const pty = runCliPty(["--ephemeral"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "interactive composer did not render",
      );
      pty.write("start work\r");
      await pty.waitForScreen(
        (screen) => screen.includes("working"),
        "assistant turn did not start",
      );

      // When
      pty.write("/tmp/output is relevant\r");
      pty.write("focus on queue visibility\r");
      pty.write("/status\r");
      pty.write("after the status barrier\r");

      // Then
      const screen = await pty.waitForScreen(
        (current) =>
          current.includes("steer/next> /tmp/output is relevant") &&
          current.includes("steer/next> focus on queue visibility") &&
          current.includes("queue> /status") &&
          current.includes("queue> after the status barrier") &&
          current.includes("runs next"),
        "steering and queued command dispositions were not visible",
      );
      expect(screen).toContain("steer/next>");
      expect(screen).toContain("queue>");
    } finally {
      pty.kill();
      server.closeAllConnections();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a real terminal session with a multiline draft,
    When the user pastes two lines and submits once,
    Then Keel sends one message with the original line break and renders one reply`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tui-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-tui-home-"));
    const sessionId = "multiline-composer";
    const pty = runCliPty(["--session", sessionId], {
      cwd: workspace,
      env: { KEEL_HOME: home, KEEL_PROVIDER: "fake" },
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "interactive composer did not render",
      );

      // When
      pty.write("\x1b[200~first line\nsecond line\x1b[201~");
      pty.write("\r");

      // Then
      const screen = await pty.waitForScreen(
        (current) =>
          current.includes("Remembered: first line") &&
          current.includes("second line"),
        "multiline reply did not render",
      );
      expect(screen).toContain("Remembered: first line");
      expect(screen).toContain("second line");

      pty.write("\x03");
      await expect(pty.exit).resolves.toMatchObject({ exitCode: 130 });

      const resumed = resumeSessionStore({
        sessionId,
        workspace,
        runtime: runtime(home),
      });
      expect(
        resumed.messages.filter((message) => message.role === "user"),
      ).toEqual([
        {
          role: "user",
          content: "first line\nsecond line",
          origin: { type: "user_prompt" },
        },
      ]);
      expect(
        resumed.messages.filter((message) => message.role === "assistant"),
      ).toEqual([
        {
          role: "assistant",
          content: "Remembered: first line\nsecond line",
          toolCalls: [],
        },
      ]);
    } finally {
      pty.kill();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a real terminal session with prompt history and an unsent draft,
    When the user browses history and resizes the terminal before returning,
    Then Keel restores the draft and submits it unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tui-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-tui-home-"));
    const sessionId = "history-draft";
    const pty = runCliPty(["--session", sessionId], {
      cwd: workspace,
      env: { KEEL_HOME: home, KEEL_PROVIDER: "fake" },
      columns: 100,
      rows: 30,
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "interactive composer did not render",
      );
      pty.write("first request\r");
      await pty.waitForScreen(
        (screen) => screen.includes("Remembered: first request"),
        "first reply did not render",
      );
      pty.write("draft survives");

      // When
      pty.resize(60, 20);
      await pty.waitForScreen(
        (screen) => screen.includes("draft survives"),
        "draft disappeared after terminal resize",
      );
      pty.write("\x1b[A");
      await pty.waitForScreen(
        (screen) =>
          !screen.includes("draft survives") &&
          (screen.match(/first request/gu)?.length ?? 0) >= 3,
        "history did not recall the previous submitted prompt",
      );
      pty.write("\x1b[B");
      await pty.waitForScreen(
        (screen) => screen.includes("draft survives"),
        "history did not restore the unsent draft",
      );
      pty.write(" after resize\r");

      // Then
      await pty.waitForScreen(
        (screen) => screen.includes("Remembered: draft survives after resize"),
        "restored draft reply did not render",
      );
      pty.write("\x03");
      await expect(pty.exit).resolves.toMatchObject({ exitCode: 130 });

      const resumed = resumeSessionStore({
        sessionId,
        workspace,
        runtime: runtime(home),
      });
      expect(
        resumed.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual(["first request", "draft survives after resize"]);
    } finally {
      pty.kill();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a real terminal session is streaming an assistant reply,
    When the user edits the next prompt before streaming finishes,
    Then output redraws preserve the draft and the next submission`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tui-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-tui-home-"));
    let firstChunkSent = () => {};
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkSent = resolve;
    });
    let finishFirstReply = () => {};
    const finishFirst = new Promise<void>((resolve) => {
      finishFirstReply = resolve;
    });
    let requestCount = 0;
    const server = createServer((req, res) => {
      req.resume();
      requestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount > 1) {
        res.end(
          sseTextReplyWithUsage("second reply", {
            prompt_tokens: 10,
            completion_tokens: 2,
          }),
        );
        return;
      }
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "streaming reply" } }] })}\n\n`,
      );
      firstChunkSent();
      void finishFirst.then(() => {
        res.end(
          sseTextReplyWithUsage(" complete", {
            prompt_tokens: 5,
            completion_tokens: 2,
          }),
        );
      });
    });
    await listen(server);
    const pty = runCliPty(["--ephemeral"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "interactive composer did not render",
      );
      pty.write("start streaming\r");
      await firstChunk;
      await pty.waitForScreen(
        (screen) => screen.includes("streaming reply"),
        "streaming reply did not render",
      );

      // When
      pty.write("draft while streaming");
      finishFirstReply();

      // Then
      await pty.waitForScreen(
        (screen) =>
          screen.includes("streaming reply complete") &&
          screen.includes("draft while streaming"),
        "stream redraw did not preserve the draft",
      );
      pty.write("\r");
      await pty.waitForScreen(
        (screen) => screen.includes("second reply"),
        "preserved draft was not submitted",
      );
      expect(requestCount).toBe(2);
      pty.write("\x03");
      await expect(pty.exit).resolves.toMatchObject({ exitCode: 130 });
    } finally {
      finishFirstReply();
      pty.kill();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a real terminal session waits with an empty composer,
    When the user sends end of input,
    Then Keel exits cleanly and restores the terminal`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tui-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-tui-home-"));
    const pty = runCliPty(["--ephemeral"], {
      cwd: workspace,
      env: { KEEL_HOME: home, KEEL_PROVIDER: "fake" },
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "interactive composer did not render",
      );

      // When
      pty.write("\x04");

      // Then
      await expect(pty.exit).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      pty.kill();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
