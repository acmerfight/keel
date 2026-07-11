import { mkdtemp, rm } from "node:fs/promises";
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

describe("Interactive TUI live status", () => {
  test(`Given a real provider turn is executing a tool,
    When activity moves from thinking to the tool and back to idle,
    Then the composer keeps the current activity visible without replacing the draft`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-live-status-"));
    const home = await mkdtemp(join(tmpdir(), "keel-live-status-home-"));
    let requestCount = 0;
    const server = createServer((req, res) => {
      req.resume();
      requestCount++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requestCount === 1) {
        res.end(
          `${sseToolCall("live_bash", "bash", { command: "sleep 1" })}${sseToolFinish()}data: [DONE]\n\n`,
        );
        return;
      }
      res.end(sseTextReplyWithUsage("finished"));
    });
    await listen(server);
    const pty = runCliPty(["--ephemeral", "--bash-policy", "trusted"], {
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
      pty.write("start activity\r");
      pty.write("draft survives activity");

      // When / Then
      const active = await pty.waitForScreen(
        (screen) =>
          screen.includes("activity: Tool: bash") &&
          screen.includes("draft survives activity"),
        "live tool activity or draft was not visible",
      );
      expect(active).toContain("steer/next>");
      await pty.waitForScreen(
        (screen) =>
          screen.includes("finished") &&
          screen.includes("draft survives activity"),
        "final output did not preserve the draft",
      );
    } finally {
      pty.kill();
      server.closeAllConnections();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session starts a budgeted Goal,
    When the Goal remains incomplete after its only turn,
    Then the latest durable Goal state remains visible beside the composer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-live-goal-"));
    const home = await mkdtemp(join(tmpdir(), "keel-live-goal-home-"));
    const pty = runCliPty(["--session", "live-goal"], {
      cwd: workspace,
      env: { KEEL_HOME: home, KEEL_PROVIDER: "fake" },
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "composer did not start",
      );

      // When
      pty.write(
        '/goal --objective "Track live Goal" --verify "false" --turns 1\r',
      );

      // Then
      const screen = await pty.waitForScreen(
        (current) =>
          current.includes("goal · budget_limited") &&
          current.includes("Track live Goal"),
        "durable live Goal status did not render",
      );
      expect(screen).toContain("keel>");
      pty.write("/goal clear\r");
      await pty.waitForScreen(
        (current) =>
          current.includes("Goal cleared") && !current.includes("goal ·"),
        "cleared Goal remained in the live region",
      );
      pty.write("\x03");
      await expect(pty.exit).resolves.toMatchObject({ exitCode: 130 });
    } finally {
      pty.kill();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
