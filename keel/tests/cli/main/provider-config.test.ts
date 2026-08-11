import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import {
  requestWithToolsSchema,
  runReportSchema,
} from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
} from "../../../src/testing/provider-sse-fixtures.ts";

describe("CLI Main - Provider Config", () => {
  test(`Given an interactive run asks for a report,
    When the CLI main completes prompts from stdin,
    Then it writes a session report`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-report-"));
    const reportPath = join(workspace, "run.json");
    const input = new PassThrough();
    input.end("remember alpha\nwhat did I ask you to remember?\n");
    const fixture = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Remembered: remember alpha\n");
      expect(fixture.stdout()).toContain("Earlier you said: remember alpha\n");
      expect(fixture.stderr()).toBe("");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report).toMatchObject({
        schemaVersion: 21,
        modelsUsed: [{ provider: "fake", model: "fake" }],
        usageByModel: [
          {
            provider: "fake",
            model: "fake",
            agentLoopTurns: 2,
            costUsd: 0,
          },
        ],
        costUsd: 0,
        contextCompactions: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an unknown provider is configured,
    When the CLI main resolves the provider for a one-shot run,
    Then it returns a provider configuration error`, async () => {
    // Given
    const fixture = createRuntime(["hello"], {
      env: { KEEL_PROVIDER: "unknown" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown provider "unknown"\n');
  });

  test(`Given root AGENTS escapes the workspace through a symlink,
    When the CLI main starts a one-shot run,
    Then it rejects the project instructions before calling the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-agents-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-cli-main-outside-"));
    await writeFile(join(outside, "secret.txt"), "SECRET_OUTSIDE_WORKSPACE");
    await symlink(join(outside, "secret.txt"), join(workspace, "AGENTS.md"));
    const fixture = createRuntime(["hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot load AGENTS.md");
      expect(fixture.stderr()).toContain("outside the workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider is selected,
    When the CLI main runs a one-shot text request,
    Then it prints the provider reply and exits successfully`, async () => {
    // Given
    const fixture = createRuntime(["hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given trusted shell mode is enabled,
    When the CLI main runs a one-shot request,
    Then it passes the allow-bash option into the agent run`, async () => {
    // Given
    const fixture = createRuntime(["--allow-bash", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given an unknown bash policy is configured,
    When the CLI main parses the request,
    Then it returns a bash policy validation error`, async () => {
    // Given
    const fixture = createRuntime(["--bash-policy", "sometimes", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --bash-policy must be one of: ask, deny, trusted.\n",
    );
  });

  test(`Given an unknown bash policy uses equals syntax,
    When the CLI main parses the request,
    Then it returns a bash policy validation error`, async () => {
    // Given
    const fixture = createRuntime(["--bash-policy=sometimes", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --bash-policy must be one of: ask, deny, trusted.\n",
    );
  });

  test(`Given bash policy is missing its value,
    When the CLI main parses the request,
    Then it returns a bash policy validation error`, async () => {
    // Given
    const fixture = createRuntime(["--bash-policy"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --bash-policy must be one of: ask, deny, trusted.\n",
    );
  });

  test.each([
    ["--allow-bash", "--bash-policy", "ask", "hello"],
    ["--allow-bash", "--bash-policy=ask", "hello"],
    ["--bash-policy=ask", "--allow-bash", "hello"],
  ])(
    `Given conflicting bash policy options %s %s,
    When the CLI main parses the request,
    Then it returns a conflict validation error`,
    async (...args) => {
      // Given
      const fixture = createRuntime(args, {
        env: { KEEL_PROVIDER: "fake" },
      });

      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.\n",
      );
    },
  );

  test(`Given bash policy is configured with equals syntax,
    When the CLI main runs a text request,
    Then it accepts the policy option`, async () => {
    // Given
    const fixture = createRuntime(["--bash-policy=trusted", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given bash policy is explicitly denied,
    When the CLI main sends a one-shot provider request,
    Then the bash tool is not exposed to the model`, async () => {
    // Given
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
        res.end(sseTextReplyWithUsage("No shell."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["--bash-policy", "deny", "hello"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("No shell.\n");
      expect(fixture.stderr()).toBe("");
      const request = requestWithToolsSchema.parse(capturedBodies[0]);
      expect(
        request.tools?.map((tool) => tool.function?.name).filter(Boolean),
      ).not.toContain("bash");
    } finally {
      await close(server);
    }
  });

  test(`Given ask bash policy is forced through non-TTY input,
    When the CLI main starts an interactive session,
    Then it rejects the unsafe approval channel`, async () => {
    // Given
    const fixture = createRuntime(["--bash-policy", "ask"], {
      env: { KEEL_FORCE_INTERACTIVE: "1" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --bash-policy ask requires a real TTY so approvals cannot be read from piped input. Use --bash-policy deny or --bash-policy trusted for non-TTY runs.\n",
    );
  });

  test(`Given the default provider is configured against a local protocol server,
    When the CLI main runs a one-shot text request,
    Then it streams the provider reply through the process boundary`, async () => {
    // Given
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Hello\u001b[31m from DeepSeek."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello\\x1b[31m from DeepSeek.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await close(server);
    }
  });

  test(`Given the provider rate limits before succeeding,
    When the CLI main runs in-process,
    Then it reports the retry before printing the final answer`, async () => {
    // Given
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": "0",
          });
          res.end(JSON.stringify({ error: { message: "Rate limited" } }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Recovered."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(requestCount).toBe(2);
      expect(fixture.stdout()).toBe("Recovered.\n");
      expect(fixture.stderr()).toBe(
        "Provider retry: DeepSeek rate limited (attempt 1/4 in 0ms)\n",
      );
    } finally {
      await close(server);
    }
  });
});
