import { describe, expect, test } from "vitest";
import {
  artifactRefsFrom,
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
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

describe("CLI Tool Output Artifacts", () => {
  test(`Given a file read is already truncated by the read tool,
    When the user runs Keel,
    Then the artifact marker and shown artifact say the saved output is source-truncated`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    await writeFile(
      join(workspace, "source-truncated.log"),
      oversizedReadFixture({
        start: "SOURCE_START",
        fill: "s",
        end: "SOURCE_END",
      }),
      "utf8",
    );
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
            sseToolCall("call_read_source_truncated", "read", {
              path: "source-truncated.log",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const secondRequest = requestWithMessagesSchema.parse(
          capturedBodies[1],
        );
        const toolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call_read_source_truncated",
        );
        const ref = firstArtifactRef(toolMessage?.content ?? "");
        const hasLossyMarker =
          toolMessage?.content?.includes(
            "source status: source-truncated/lossy before artifact capture",
          ) === true;
        res.end(
          sseTextReplyWithUsage(
            hasLossyMarker
              ? `source-truncated artifact ${ref}`
              : `missing source-truncated marker ${ref}`,
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["inspect source-truncated.log"], {
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
        /^source-truncated artifact tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\n$/u,
      );
      const ref = firstArtifactRef(result.stdout);
      expect(result.stderr).toContain(`Tool output artifact: ${ref}`);

      const shown = await runCli(["artifacts", "show", ref], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("sourceStatus: source-truncated");
      expect(shown.stdout).toContain("[Read output truncated");
      expect(shown.stdout).toContain("SOURCE_END");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the artifact store cannot write under KEEL_HOME,
    When the user runs Keel on an oversized tool result,
    Then the run still completes and the visible result says the omitted output is lossy`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-artifacts-"));
    const homeParent = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const blockedHome = join(homeParent, "blocked-home");
    await writeFile(blockedHome, "not a directory", "utf8");
    await writeFile(
      join(workspace, "large.log"),
      oversizedReadFixture({
        start: "FAILED_STORE_START",
        fill: "f",
        end: "FAILED_STORE_END",
      }),
      "utf8",
    );
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
            sseToolCall("call_read_large", "read", { path: "large.log" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const secondRequest = requestWithMessagesSchema.parse(
          capturedBodies[1],
        );
        const toolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call_read_large",
        );
        const lossy =
          toolMessage?.content?.includes("artifact storage failed:") === true &&
          toolMessage.content.includes("lossy; rerun") &&
          artifactRefsFrom(toolMessage.content).length === 0;
        res.end(
          sseTextReplyWithUsage(
            lossy ? "lossy storage failure visible" : "lossy marker missing",
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["inspect large.log"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: blockedHome,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("lossy storage failure visible\n");
      expect(result.stderr).toContain("Tool output artifact failed:");
      expect(result.stderr).toContain("lossy; rerun");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(homeParent, { recursive: true, force: true });
    }
  });

  test(`Given the artifact ref is malformed,
    When the user runs artifacts show,
    Then the CLI rejects it without reading outside KEEL_HOME`, async () => {
    // Given
    const result = await runCli(["artifacts", "show", "../secret"], {
      env: { KEEL_HOME: "/tmp/unused-keel-home" },
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Error: invalid artifact ref "../secret". Use tool-output:<scope>/<id>.\n',
    );
  });
});
