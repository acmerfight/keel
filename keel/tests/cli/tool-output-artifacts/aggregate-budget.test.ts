import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  firstArtifactRef,
  getPort,
  join,
  listen,
  mkdtemp,
  oversizedReadFixture,
  requestWithMessagesSchema,
  rm,
  runCli,
  sseReadToolCalls,
  sseTextReplyWithUsage,
  sseToolFinish,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

describe("CLI Tool Output Artifacts", () => {
  test(`Given one model turn reads many medium workspace files,
    When their combined output exceeds the aggregate inline budget,
    Then the largest output is saved as an artifact before smaller outputs`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    await writeFile(
      join(workspace, "largest.log"),
      ["LARGEST_START", "a".repeat(49_000), "LARGEST_END"].join("\n"),
      "utf8",
    );
    for (const name of ["small-a", "small-b", "small-c", "small-d"]) {
      await writeFile(
        join(workspace, `${name}.log`),
        [
          `${name.toUpperCase()}_START`,
          name.repeat(6_100),
          `${name.toUpperCase()}_END`,
        ].join("\n"),
        "utf8",
      );
    }
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (capturedBodies.length === 1) {
          res.write(
            sseReadToolCalls([
              { id: "call_read_largest", path: "largest.log" },
              { id: "call_read_small_a", path: "small-a.log" },
              { id: "call_read_small_b", path: "small-b.log" },
              { id: "call_read_small_c", path: "small-c.log" },
              { id: "call_read_small_d", path: "small-d.log" },
            ]),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const secondRequest = requestWithMessagesSchema.parse(
          capturedBodies[1],
        );
        const largestToolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call_read_largest",
        );
        const smallToolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call_read_small_d",
        );
        const ref = firstArtifactRef(largestToolMessage?.content ?? "");
        const aggregateHandled =
          largestToolMessage?.content?.includes("LARGEST_START") === true &&
          largestToolMessage.content.includes("LARGEST_END") === false &&
          largestToolMessage.content.includes("keel artifacts show") === true &&
          smallToolMessage?.content?.includes("SMALL-D_START") === true &&
          smallToolMessage.content.includes("SMALL-D_END") === true &&
          smallToolMessage.content.includes("keel artifacts show") === false;
        res.end(
          sseTextReplyWithUsage(
            aggregateHandled
              ? `aggregate artifact ${ref}`
              : `aggregate artifact missing ${ref}`,
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["inspect both logs"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(
        /^aggregate artifact tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\n$/u,
      );
      const ref = firstArtifactRef(result.stdout);
      expect(result.stderr).toContain(`Tool output artifact: ${ref}`);

      const shown = await runCli(["artifacts", "show", ref], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("tool: read");
      expect(shown.stdout).toContain("sourceStatus: complete");
      expect(shown.stdout).toContain("LARGEST_START");
      expect(shown.stdout).toContain("LARGEST_END");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a small tool output follows a large artifact-backed output,
    When the CLI sends the next provider request,
    Then the small output stays inline instead of becoming an empty-preview artifact`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const smallOutput = ["SMALL_START", "ok", "SMALL_END"].join("\n");
    await writeFile(
      join(workspace, "large.log"),
      oversizedReadFixture({
        start: "LARGE_START",
        fill: "a",
        end: "LARGE_END",
      }),
      "utf8",
    );
    await writeFile(join(workspace, "small.log"), smallOutput, "utf8");
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (capturedBodies.length === 1) {
          res.write(
            sseReadToolCalls([
              { id: "call_read_large", path: "large.log" },
              { id: "call_read_small", path: "small.log" },
            ]),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const secondRequest = requestWithMessagesSchema.parse(
          capturedBodies[1],
        );
        const largeToolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call_read_large",
        );
        const smallToolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call_read_small",
        );
        const smallStayedInline =
          largeToolMessage?.content?.includes("keel artifacts show") === true &&
          largeToolMessage.content.includes("LARGE_END") === false &&
          smallToolMessage?.content === smallOutput;
        res.end(
          sseTextReplyWithUsage(
            smallStayedInline ? "small output inline" : "small output lost",
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["inspect large and small logs"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("small output inline\n");
      expect(result.stderr.match(/Tool output artifact:/gu)).toHaveLength(1);
      const ref = firstArtifactRef(result.stderr);
      const shown = await runCli(["artifacts", "show", ref], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("LARGE_END");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
