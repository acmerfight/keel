import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { requestWithMessagesSchema } from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

function artifactRefsFrom(text: string): readonly string[] {
  return Array.from(
    text.matchAll(/tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/gu),
    (match) => match[0],
  );
}

function firstArtifactRef(text: string): string {
  const ref = artifactRefsFrom(text)[0];
  if (ref === undefined) {
    throw new Error(`No artifact ref found in:\n${text}`);
  }
  return ref;
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseReadToolCalls(
  calls: readonly { readonly id: string; readonly path: string }[],
): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: call.path }),
            },
          })),
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

describe("CLI Main - Tool Output Artifacts", () => {
  test(`Given the provider reads a large workspace file,
    When CLI main runs and the user opens the artifact ref,
    Then the model prompt is shortened and artifacts show prints the full output`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    await writeFile(
      join(workspace, "large.log"),
      [
        "FULL_READ_START",
        "large output hidden from the model prompt ".repeat(180),
        "A log line can mention a fake ref such as tool-output:not-real/ref.",
        "FULL_READ_END",
      ].join("\n"),
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
        const ref = firstArtifactRef(toolMessage?.content ?? "");
        const shortened =
          toolMessage?.content?.includes("FULL_READ_START") === true &&
          toolMessage.content.includes("FULL_READ_END") === false &&
          toolMessage.content.includes("keel artifacts show") === true;
        res.end(
          sseTextReplyWithUsage(
            shortened ? `artifact ready ${ref}` : `artifact missing ${ref}`,
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const run = createRuntime(["inspect large.log"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      });
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toMatch(
        /^artifact ready tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\n$/u,
      );
      const ref = firstArtifactRef(`${run.stdout()}\n${run.stderr()}`);
      expect(run.stderr()).toContain(`Tool output artifact: ${ref}`);
      expect(run.stderr()).toContain(`keel artifacts show ${ref}`);

      const show = createRuntime(["artifacts", "show", ref], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const showExitCode = await runCliMain(show.runtime);
      expect(showExitCode).toBe(0);
      expect(show.stderr()).toBe("");
      expect(show.stdout()).toContain(`ref: ${ref}`);
      expect(show.stdout()).toContain("tool: read");
      expect(show.stdout()).toContain("sourceStatus: complete");
      expect(show.stdout()).toContain(
        "atRestPolicy: raw unredacted tool output",
      );
      expect(show.stdout()).toContain("tool-output:not-real/ref");
      expect(show.stdout()).toContain("FULL_READ_END");
      expect(await readdir(workspace)).toEqual(["large.log"]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one model turn reads multiple medium workspace files,
    When their combined output exceeds the inline budget,
    Then CLI main saves the later output as an artifact the user can inspect`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    await writeFile(
      join(workspace, "first.log"),
      ["FIRST_START", "a".repeat(1500), "FIRST_END"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, "second.log"),
      ["SECOND_START", "b".repeat(1500), "SECOND_END"].join("\n"),
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
            sseReadToolCalls([
              { id: "call_read_first", path: "first.log" },
              { id: "call_read_second", path: "second.log" },
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
        const firstToolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call_read_first",
        );
        const secondToolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call_read_second",
        );
        const ref = firstArtifactRef(secondToolMessage?.content ?? "");
        const aggregateHandled =
          firstToolMessage?.content?.includes("FIRST_END") === true &&
          secondToolMessage?.content?.includes("SECOND_START") === true &&
          secondToolMessage.content.includes("SECOND_END") === false &&
          secondToolMessage.content.includes("keel artifacts show") === true;
        res.end(
          sseTextReplyWithUsage(
            aggregateHandled
              ? `aggregate artifact ${ref}`
              : `aggregate missing ${ref}`,
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const run = createRuntime(["inspect both logs"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      });
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      const ref = firstArtifactRef(run.stdout());
      expect(run.stdout()).toBe(`aggregate artifact ${ref}\n`);
      expect(run.stderr()).toContain(`Tool output artifact: ${ref}`);

      const show = createRuntime(["artifacts", "show", ref], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const showExitCode = await runCliMain(show.runtime);
      expect(showExitCode).toBe(0);
      expect(show.stdout()).toContain("SECOND_START");
      expect(show.stdout()).toContain("SECOND_END");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a small tool output follows a large artifact-backed output,
    When CLI main sends the next provider request,
    Then the small output stays inline instead of becoming an empty-preview artifact`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const smallOutput = ["SMALL_START", "ok", "SMALL_END"].join("\n");
    await writeFile(
      join(workspace, "large.log"),
      ["LARGE_START", "a".repeat(3000), "LARGE_END"].join("\n"),
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
      const run = createRuntime(["inspect large and small logs"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      });
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toBe("small output inline\n");
      expect(run.stderr().match(/Tool output artifact:/gu)).toHaveLength(1);
      const ref = firstArtifactRef(run.stderr());
      const show = createRuntime(["artifacts", "show", ref], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const showExitCode = await runCliMain(show.runtime);
      expect(showExitCode).toBe(0);
      expect(show.stdout()).toContain("LARGE_END");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a bash command output was capped before Keel could persist it,
    When CLI main stores the shortened result,
    Then the artifact shown to the user is marked source-truncated`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
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
            sseToolCall("call_noisy_bash", "bash", {
              command:
                "node -e \"process.stdout.write('SOURCE_START\\n' + 'x'.repeat(25000) + '\\nSOURCE_END')\"",
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
            message.tool_call_id === "call_noisy_bash",
        );
        const ref = firstArtifactRef(toolMessage?.content ?? "");
        const lossy =
          toolMessage?.content?.includes(
            "source status: source-truncated/lossy before artifact capture",
          ) === true;
        res.end(
          sseTextReplyWithUsage(
            lossy ? `source-truncated artifact ${ref}` : `missing lossy ${ref}`,
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const run = createRuntime(["--allow-bash", "run noisy command"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      });
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      const ref = firstArtifactRef(run.stdout());
      expect(run.stdout()).toBe(`source-truncated artifact ${ref}\n`);

      const show = createRuntime(["artifacts", "show", ref], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const showExitCode = await runCliMain(show.runtime);
      expect(showExitCode).toBe(0);
      expect(show.stdout()).toContain("sourceStatus: source-truncated");
      expect(show.stdout()).toContain("[bash stdout truncated:");
      expect(show.stdout()).toContain("SOURCE_END");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME cannot hold artifacts,
    When CLI main receives an oversized tool result,
    Then the run completes and the user-visible output is marked lossy`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
    const homeParent = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const blockedHome = join(homeParent, "blocked-home");
    await writeFile(blockedHome, "not a directory", "utf8");
    await writeFile(
      join(workspace, "large.log"),
      [
        "FAILED_STORE_START",
        "storage failure ".repeat(250),
        "FAILED_STORE_END",
      ].join("\n"),
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
      const run = createRuntime(["inspect large.log"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: blockedHome,
        },
      });
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toBe("lossy storage failure visible\n");
      expect(run.stderr()).toContain("Tool output artifact failed:");
      expect(run.stderr()).toContain("lossy; rerun");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(homeParent, { recursive: true, force: true });
    }
  });

  test(`Given the user asks to show invalid or missing artifact refs,
    When CLI main handles artifacts show,
    Then it rejects unsafe refs and reports missing managed artifacts`, async () => {
    // Given / When
    const invalid = createRuntime(["artifacts", "show", "../secret"], {
      env: { KEEL_HOME: "/tmp/unused-keel-home" },
    });
    const invalidExitCode = await runCliMain(invalid.runtime);
    const traversal = createRuntime(
      ["artifacts", "show", "tool-output:a..b/id"],
      {
        env: { KEEL_HOME: "/tmp/unused-keel-home" },
      },
    );
    const traversalExitCode = await runCliMain(traversal.runtime);
    const missing = createRuntime(["artifacts", "show", "tool-output:run/id"], {
      env: { KEEL_HOME: "/tmp/unused-keel-home" },
    });
    const missingExitCode = await runCliMain(missing.runtime);
    const noSubcommand = createRuntime(["artifacts"]);
    const noSubcommandExitCode = await runCliMain(noSubcommand.runtime);
    const unknownSubcommand = createRuntime(["artifacts", "list"]);
    const unknownSubcommandExitCode = await runCliMain(
      unknownSubcommand.runtime,
    );
    const missingRef = createRuntime(["artifacts", "show"]);
    const missingRefExitCode = await runCliMain(missingRef.runtime);
    const extra = createRuntime([
      "artifacts",
      "show",
      "tool-output:run/id",
      "x",
    ]);
    const extraExitCode = await runCliMain(extra.runtime);

    // Then
    expect(invalidExitCode).toBe(1);
    expect(invalid.stderr()).toBe(
      'Error: invalid artifact ref "../secret". Use tool-output:<scope>/<id>.\n',
    );
    expect(traversalExitCode).toBe(1);
    expect(traversal.stderr()).toBe(
      'Error: invalid artifact ref "tool-output:a..b/id". Use tool-output:<scope>/<id>.\n',
    );
    expect(missingExitCode).toBe(1);
    expect(missing.stderr()).toContain(
      "Error: cannot read artifact tool-output:run/id:",
    );
    expect(noSubcommandExitCode).toBe(1);
    expect(noSubcommand.stderr()).toBe(
      "Error: artifacts requires a subcommand: show.\n",
    );
    expect(unknownSubcommandExitCode).toBe(1);
    expect(unknownSubcommand.stderr()).toBe(
      'Error: unknown artifacts subcommand "list"\n',
    );
    expect(missingRefExitCode).toBe(1);
    expect(missingRef.stderr()).toBe("Error: artifacts show requires <ref>.\n");
    expect(extraExitCode).toBe(1);
    expect(extra.stderr()).toBe('Error: unknown artifacts show option "x"\n');
  });
});
