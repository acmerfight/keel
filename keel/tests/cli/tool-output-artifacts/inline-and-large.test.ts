import { describe, expect, test } from "vitest";
import {
  artifactPaths,
  close,
  createServer,
  firstArtifactRef,
  getPort,
  join,
  listen,
  mkdtemp,
  oversizedReadFixture,
  readdir,
  requestWithMessagesSchema,
  rm,
  runCli,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
  stat,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

describe("CLI Tool Output Artifact Smoke", () => {
  test(`Given the provider reads a large workspace file,
    When the user runs Keel and then opens the printed artifact ref,
    Then the real CLI keeps the prompt small and prints the full stored output`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const rawSecretPastPreview = "API_KEY=sk-artifact-secret-213";
    const largeOutput = oversizedReadFixture({
      start: "FULL_READ_START",
      fill: "x",
      end: ["FULL_READ_END", rawSecretPastPreview].join("\n"),
    });
    await writeFile(join(workspace, "large.log"), largeOutput, "utf8");
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
        const ref = firstArtifactRef(toolMessage?.content ?? "");
        const visibleToModel =
          toolMessage?.content?.includes("FULL_READ_START") === true &&
          toolMessage.content.includes("FULL_READ_END") === false &&
          toolMessage.content.includes(rawSecretPastPreview) === false &&
          toolMessage.content.includes("keel artifacts show") === true &&
          toolMessage.content.includes(
            "model recovery: rerun the tool with narrower parameters if needed",
          ) === true;
        res.end(
          sseTextReplyWithUsage(
            visibleToModel
              ? `artifact ready ${ref}`
              : `artifact marker missing ${ref}`,
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
          KEEL_HOME: home,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(
        /^artifact ready tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\n$/u,
      );
      const ref = firstArtifactRef(`${result.stdout}\n${result.stderr}`);
      expect(result.stderr).toContain(`Tool output artifact: ${ref}`);
      expect(result.stderr).toContain(`keel artifacts show ${ref}`);

      const shown = await runCli(["artifacts", "show", ref], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      expect(shown.exitCode).toBe(0);
      expect(shown.stderr).toBe("");
      expect(shown.stdout).toContain(`ref: ${ref}`);
      expect(shown.stdout).toContain("tool: read");
      expect(shown.stdout).toContain("sourceStatus: source-truncated");
      expect(shown.stdout).toContain(
        "atRestPolicy: raw unredacted tool output",
      );
      expect(shown.stdout).toContain("FULL_READ_START");
      expect(shown.stdout).toContain("FULL_READ_END");
      expect(shown.stdout).toContain(rawSecretPastPreview);
      expect(shown.stdout).not.toContain("[REDACTED_SECRET]");
      const paths = artifactPaths(home, ref);
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.file)).mode & 0o777).toBe(0o600);
      expect(await readdir(workspace)).toEqual(["large.log"]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
