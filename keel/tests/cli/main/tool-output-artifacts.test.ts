import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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

function oversizedReadFixture(options: {
  readonly start: string;
  readonly end: string;
  readonly fill: string;
}): string {
  return [
    options.start,
    options.fill.repeat(51_000),
    options.end,
    "tail beyond the read tool byte budget ".repeat(200),
  ].join("\n");
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
  test(`Given CLI main reads a moderately sized workspace file,
    When the provider receives the next request,
    Then the default artifact policy keeps the full output inline`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const mediumOutput = [
      "MEDIUM_READ_START",
      "medium output visible to the model prompt ".repeat(80),
      "MEDIUM_READ_END",
    ].join("\n");
    await writeFile(join(workspace, "medium.log"), mediumOutput, "utf8");
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
            sseToolCall("call_read_medium", "read", { path: "medium.log" }),
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
            message.tool_call_id === "call_read_medium",
        );
        const stayedInline =
          toolMessage?.content === mediumOutput &&
          toolMessage.content.includes("keel artifacts show") === false;
        res.end(
          sseTextReplyWithUsage(
            stayedInline ? "medium output inline" : "medium output artifacted",
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const run = createRuntime(["inspect medium.log"], {
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
      expect(run.stdout()).toBe("medium output inline\n");
      expect(run.stderr()).not.toContain("Tool output artifact:");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the provider reads a large workspace file,
    When CLI main runs and the user opens the artifact ref,
    Then the model prompt is shortened and artifacts show prints the full output`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    await writeFile(
      join(workspace, "large.log"),
      oversizedReadFixture({
        start: "FULL_READ_START",
        fill: "x",
        end: "FULL_READ_END",
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
      expect(show.stdout()).toContain("sourceStatus: source-truncated");
      expect(show.stdout()).toContain(
        "atRestPolicy: raw unredacted tool output",
      );
      expect(show.stdout()).toContain("FULL_READ_END");
      expect(await readdir(workspace)).toEqual(["large.log"]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one model turn reads many medium workspace files,
    When their combined output exceeds the aggregate inline budget,
    Then CLI main saves the largest output before smaller outputs`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
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
      expect(show.stdout()).toContain("LARGEST_START");
      expect(show.stdout()).toContain("LARGEST_END");
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

  test(`Given a file read was capped before Keel could persist it,
    When CLI main stores the shortened result,
    Then the artifact shown to the user is marked source-truncated`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
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
      const run = createRuntime(["inspect source-truncated.log"], {
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
      expect(show.stdout()).toContain("[Read output truncated");
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

  test(`Given expired tool output artifacts exist under KEEL_HOME,
    When CLI main starts an agent run,
    Then artifact cleanup removes expired files and keeps recent files`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-artifacts-"));
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const scopeDirectory = join(
      home,
      "artifacts",
      "tool-output",
      "session-cleanup",
    );
    const artifactRoot = join(home, "artifacts", "tool-output");
    await mkdir(scopeDirectory, { recursive: true });
    await writeFile(join(artifactRoot, "not-a-scope-file"), "ignored", "utf8");
    await mkdir(join(artifactRoot, "bad..scope"));
    const expiredArtifact = join(scopeDirectory, "expired.txt");
    const recentArtifact = join(scopeDirectory, "recent.txt");
    const ignoredExtensionArtifact = join(scopeDirectory, "ignored.md");
    const invalidIdArtifact = join(scopeDirectory, "bad..id.txt");
    await writeFile(expiredArtifact, "expired artifact", "utf8");
    await writeFile(recentArtifact, "recent artifact", "utf8");
    await writeFile(ignoredExtensionArtifact, "ignored extension", "utf8");
    await writeFile(invalidIdArtifact, "invalid id", "utf8");
    await mkdir(join(scopeDirectory, "nested.txt"));
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 0, 31);
    await utimes(
      expiredArtifact,
      new Date(now - 31 * dayMs),
      new Date(now - 31 * dayMs),
    );
    await utimes(recentArtifact, new Date(now - dayMs), new Date(now - dayMs));
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end(sseTextReplyWithUsage("cleanup complete"));
    });
    await listen(server);

    try {
      // When
      const run = createRuntime(["hello"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
        now: () => now,
      });
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toBe("cleanup complete\n");
      expect((await readdir(scopeDirectory)).sort()).toEqual([
        "bad..id.txt",
        "ignored.md",
        "nested.txt",
        "recent.txt",
      ]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a stored artifact already ends with a newline,
    When CLI main shows the artifact,
    Then the output is not padded with an extra blank line`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const scopeDirectory = join(
      home,
      "artifacts",
      "tool-output",
      "show-newline",
    );
    await mkdir(scopeDirectory, { recursive: true });
    await writeFile(join(scopeDirectory, "artifact.txt"), "already newline\n");

    try {
      // When
      const show = createRuntime(
        ["artifacts", "show", "tool-output:show-newline/artifact"],
        {
          env: { KEEL_HOME: home },
        },
      );
      const exitCode = await runCliMain(show.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(show.stdout()).toBe("already newline\n");
    } finally {
      await rm(home, { recursive: true, force: true });
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
