import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliPty } from "../../../src/testing/cli-pty-harness.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

describe("Interactive TUI readable transcript", () => {
  test(`Given an interactive turn reads a file and returns Markdown,
    When the tool settles and the response finishes,
    Then the transcript distinguishes the user, rendered answer, settled tool, and composer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-readable-tui-"));
    const home = await mkdtemp(join(tmpdir(), "keel-readable-tui-home-"));
    await writeFile(join(workspace, "note.md"), "audit trail\n");
    let markdownStarted = () => {};
    const firstMarkdownChunk = new Promise<void>((resolve) => {
      markdownStarted = resolve;
    });
    let finishMarkdown = () => {};
    const markdownFinish = new Promise<void>((resolve) => {
      finishMarkdown = resolve;
    });
    let requestCount = 0;
    const server = createServer((request, response) => {
      request.resume();
      requestCount++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requestCount === 1) {
        response.end(
          `${sseToolCall("read_note", "read", { path: "note.md" })}${sseToolFinish()}data: [DONE]\n\n`,
        );
        return;
      }
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content:
                  "# Result\n\n- tool settled through streaming Markdown",
              },
            },
          ],
        })}\n\n`,
      );
      markdownStarted();
      void markdownFinish.then(() => {
        response.end(
          sseTextReplyWithUsage(" and reflows after terminal resize\n\n`done`"),
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
        "composer did not start",
      );

      // When
      pty.write("inspect note.md\r");
      await firstMarkdownChunk;
      const partial = await pty.waitForScreen(
        (current) =>
          current.includes("tool settled through streaming Markdown"),
        "first Markdown chunk did not render",
      );
      expect(partial).not.toContain("reflows after terminal resize");
      finishMarkdown();

      // Then
      const wide = await pty.waitForScreen(
        (current) =>
          current.includes("reflows after terminal resize") &&
          current.includes("keel>"),
        "settled readable transcript did not render",
      );
      const renderedSentence =
        "tool settled through streaming Markdown and reflows after terminal resize";
      expect(
        wide.split("\n").some((line) => line.includes(renderedSentence)),
      ).toBe(true);
      pty.resize(34, 24);
      const narrow = await pty.waitForScreen(
        (current) =>
          current.includes("streaming") &&
          current.includes("Markdown") &&
          current.includes("terminal resize"),
        "Markdown content disappeared after resize",
      );
      expect(
        narrow.split("\n").some((line) => line.includes(renderedSentence)),
      ).toBe(false);
      expect(narrow).toContain("› inspect note.md");
      expect(narrow).toContain("✓ read note.md");
      expect(narrow).toContain("• tool settled");
      expect(narrow).toContain("Result");
      expect(narrow).toContain("done");
      expect(narrow).not.toContain("◦ read note.md");
      expect(narrow).not.toContain("# Result");
      expect(narrow).not.toContain("assistant:");
      expect(narrow).not.toContain("status: Tool:");
    } finally {
      finishMarkdown();
      pty.kill();
      server.closeAllConnections();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one provider turn starts two read calls,
    When one succeeds and the other fails,
    Then both tool rows settle independently in the real PTY`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-readable-tools-"));
    const home = await mkdtemp(join(tmpdir(), "keel-readable-tools-home-"));
    await writeFile(join(workspace, "note.md"), "present\n");
    let requestCount = 0;
    const server = createServer((request, response) => {
      request.resume();
      requestCount++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requestCount === 1) {
        response.end(
          [
            sseToolCall(
              "read_present",
              "read",
              { path: "note.md" },
              { index: 0 },
            ),
            sseToolCall(
              "read_missing",
              "read",
              { path: "missing.md" },
              { index: 1 },
            ),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
        return;
      }
      response.end(sseTextReplyWithUsage("Both reads checked."));
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
        "multi-tool composer did not start",
      );

      // When
      pty.write("check both files\r");

      // Then
      const screen = await pty.waitForScreen(
        (current) =>
          current.includes("Both reads checked") && current.includes("keel>"),
        "multi-tool transcript did not settle",
      );
      expect(screen).toContain("✓ read note.md");
      expect(screen).toContain("✗ read missing.md");
      expect(screen).not.toContain("◦ read note.md");
      expect(screen).not.toContain("◦ read missing.md");
    } finally {
      pty.kill();
      server.closeAllConnections();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a narrow no-color terminal and a tool that fails,
    When a CJK prompt completes with an error,
    Then structure alone keeps the failure and composer readable`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-readable-fail-"));
    const home = await mkdtemp(join(tmpdir(), "keel-readable-fail-home-"));
    let requestCount = 0;
    const server = createServer((request, response) => {
      request.resume();
      requestCount++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requestCount === 1) {
        response.end(
          `${sseToolCall("read_missing", "read", { path: "missing.txt" })}${sseToolFinish()}data: [DONE]\n\n`,
        );
        return;
      }
      response.end(sseTextReplyWithUsage("## 无法读取\n\n文件不存在。"));
    });
    await listen(server);
    const pty = runCliPty(["--ephemeral"], {
      cwd: workspace,
      columns: 42,
      rows: 24,
      env: {
        KEEL_HOME: home,
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        NO_COLOR: "1",
      },
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "narrow composer did not start",
      );

      // When
      pty.write("读取不存在文件\r");

      // Then
      const screen = await pty.waitForScreen(
        (current) =>
          current.includes("文件不存在") && current.includes("keel>"),
        "narrow failure transcript did not settle",
      );
      expect(screen).toContain("› 读取不存在文件");
      expect(screen).toContain("✗ read missing.txt");
      expect(screen).toContain("无法读取");
      expect(screen).not.toContain("◦ read missing.txt");
      const ansiEscape = String.fromCharCode(27);
      for (const code of [
        "1",
        "2",
        "3",
        "4",
        "9",
        "31",
        "32",
        "33",
        "34",
        "35",
        "36",
        "1;36",
        "4;36",
      ]) {
        expect(pty.rawOutput()).not.toContain(`${ansiEscape}[${code}m`);
      }
    } finally {
      pty.kill();
      server.closeAllConnections();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a tool is running in an interactive turn,
    When the user interrupts the turn,
    Then the audit row settles as interrupted instead of staying active`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-readable-abort-"));
    const home = await mkdtemp(join(tmpdir(), "keel-readable-abort-home-"));
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `${sseToolCall("sleeping", "bash", { command: "sleep 10" })}${sseToolFinish()}data: [DONE]\n\n`,
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
        "interrupt composer did not start",
      );
      pty.write("start long tool\r");
      await pty.waitForScreen(
        (screen) => screen.includes("◦ bash sleep 10"),
        "running tool row did not render",
      );

      // When
      pty.write("\x03");

      // Then
      const screen = await pty.waitForScreen(
        (current) =>
          current.includes("! bash sleep 10 · interrupted") &&
          current.includes("keel>"),
        "interrupted tool row did not settle",
      );
      expect(screen).not.toContain("◦ bash sleep 10");
    } finally {
      pty.kill();
      server.closeAllConnections();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
