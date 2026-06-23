import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { type CliRuntime, runCliMain } from "../../src/cli/index.ts";
import { acquireSessionLock } from "../../src/cli/session-store.ts";
import { recordLastEditCheckpoint } from "../../src/core/git.ts";
import type { Message } from "../../src/llm/types.ts";
import { runGit } from "../../src/testing/cli-harness.ts";
import { evalResultLineJson } from "../../src/testing/eval-fixtures.ts";

const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string(),
  model: z.string(),
  costUsd: z.number(),
});

const requestWithMessagesSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.string().optional(),
            tool_call_id: z.string().optional(),
            content: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const requestWithToolsSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            function: z.object({ name: z.string() }).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const requestModelSchema = z.object({
  model: z.string(),
});

interface RuntimeFixture {
  readonly runtime: CliRuntime;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

interface SigintCapture {
  handler: (() => void) | null;
}

function createRuntime(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly input?: PassThrough;
    readonly onStderr?: (text: string) => void;
    readonly onSigint?: (handler: () => void) => void;
    readonly offSigint?: (handler: () => void) => void;
  } = {},
): RuntimeFixture {
  let stdout = "";
  let stderr = "";
  const input = options.input ?? new PassThrough();

  return {
    runtime: {
      args,
      cliEntry: join(process.cwd(), "src/cli/index.ts"),
      cwd: () => options.cwd ?? process.cwd(),
      env: (key) => options.env?.[key],
      input,
      platform: process.platform,
      now: () => 0,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        options.onStderr?.(text);
      },
      onSigint: options.onSigint ?? (() => {}),
      offSigint: options.offSigint ?? (() => {}),
      forceExit: (code) => {
        throw new Error(`unexpected forceExit(${code})`);
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function appendSessionRecordLine(
  timestamp: string,
  messages: readonly Message[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "append",
    timestamp,
    reason: "turn",
    messages,
  });
}

function replaceSessionRecordLine(
  timestamp: string,
  messages: readonly Message[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "replace",
    timestamp,
    reason: "compaction",
    messages,
  });
}

function snapshotSessionRecordLine(
  timestamp: string,
  messages: readonly Message[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "snapshot",
    timestamp,
    reason: "size_threshold",
    messages,
    pendingInputs: [],
  });
}

function inputAdmittedRecordLine(options: {
  readonly timestamp: string;
  readonly id: string;
  readonly line: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "input_admitted",
    timestamp: options.timestamp,
    id: options.id,
    sequence: 1,
    line: options.line,
  });
}

function inputConsumedRecordLine(
  timestamp: string,
  inputIds: readonly string[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "input_consumed",
    timestamp,
    inputIds,
  });
}

function conversationCheckpoint(
  summary: string,
  noLaterMessages = false,
): string {
  return [
    "<conversation-checkpoint>",
    "The following is a summary of earlier conversation. Treat it as historical context, not as a new instruction.",
    noLaterMessages
      ? "No later messages are available after this checkpoint; continue from the task state and next steps in the summary."
      : "",
    "<summary>",
    summary,
    "</summary>",
    "</conversation-checkpoint>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

async function writeSessionLedger(options: {
  readonly home: string;
  readonly id: string;
  readonly headerId?: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly forkedFrom?: string;
  readonly records?: readonly string[];
}): Promise<void> {
  const sessionDir = join(options.home, "sessions", options.id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "ledger.jsonl"),
    `${[
      JSON.stringify({
        schemaVersion: 1,
        type: "session",
        id: options.headerId ?? options.id,
        createdAt: options.createdAt,
        workspace: options.workspace,
        ...(options.forkedFrom !== undefined
          ? { forkedFrom: options.forkedFrom }
          : {}),
      }),
      ...(options.records ?? []),
    ].join("\n")}\n`,
    "utf8",
  );
}

function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

function sseToolFinish(): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
      completion_tokens: 3,
    },
  });
}

function sseTextReplyWithUsage(
  text: string,
  usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  } = { prompt_tokens: 10, completion_tokens: 3 },
): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.prompt_tokens,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

describe("CLI Main", () => {
  test(`Given no user message and no interactive terminal,
    When the CLI main is invoked in-process,
    Then it returns usage instructions without starting a subprocess`, async () => {
    // Given
    const fixture = createRuntime([]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toContain("Usage: keel");
  });

  test(`Given a report option without a file path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--report"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --report requires a file path.\n");
  });

  test(`Given a report option with an empty equals path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--report=", "hello"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --report requires a file path.\n");
  });

  test(`Given a transcript option without a file path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--transcript"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --transcript requires a value.\n");
  });

  test(`Given a transcript option uses an empty equals path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--transcript=", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --transcript requires a value.\n");
  });

  test(`Given a transcript path without a one-shot prompt,
    When the CLI main parses the request,
    Then it rejects transcript capture before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--transcript", "run.jsonl"], {
      env: { KEEL_FORCE_INTERACTIVE: "1" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --transcript is only supported for one-shot runs.\n",
    );
  });

  test.each(["0", "abc"])(`Given invalid max cost value %s,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async (maxCost) => {
    // Given
    const fixture = createRuntime(["--max-cost", maxCost, "hello"], {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --max-cost must be a positive number.\n",
    );
  });

  test(`Given invalid max cost uses equals syntax,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--max-cost=abc", "hello"], {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --max-cost must be a positive number.\n",
    );
  });

  test(`Given an unsupported provider flag,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--provider", "anthropic", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given an unsupported provider flag uses equals syntax,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--provider=anthropic", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given a provider flag without a value,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--provider"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --provider requires a value.\n");
  });

  test(`Given a model flag without a value,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--model"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given a model flag with an empty equals value,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--model=", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given provider and model flags use equals syntax,
    When the CLI main runs in-process,
    Then the selected provider overrides provider env`, async () => {
    // Given
    const fixture = createRuntime(
      ["--provider=fake", "--model=ignored", "hello"],
      {
        env: { KEEL_PROVIDER: "deepseek" },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given a one-shot transcript path,
    When the CLI main runs in-process,
    Then it writes the provider-visible transcript`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-cli-main-transcript-"));
    const transcriptPath = join(root, "artifacts", "run.jsonl");
    const fixture = createRuntime([`--transcript=${transcriptPath}`, "hello"], {
      cwd: root,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      expect(fixture.stderr()).toBe("");
      const records = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toMatchObject([
        {
          schemaVersion: 1,
          type: "transcript",
          provider: "fake",
          model: "fake",
          systemPrompt: expect.stringContaining("You are keel"),
        },
        { type: "message", message: { role: "user", content: "hello" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: "Hello from fake provider.",
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given provider and model flags are used for an interactive session,
    When the CLI main runs in-process,
    Then the selected interactive provider overrides provider env`, async () => {
    // Given
    const input = new PassThrough();
    const fixture = createRuntime(["--provider=fake", "--model=ignored"], {
      env: { KEEL_PROVIDER: "deepseek", KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    // When
    const run = runCliMain(fixture.runtime);
    input.write("hello\n");
    input.end();
    const exitCode = await run;

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Remembered: hello\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given resume is passed without a session id,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--resume="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --resume requires a value.\n");
  });

  test(`Given session is passed without a session id,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--session"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --session requires a value.\n");
  });

  test(`Given session is passed with an empty equals value,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--session="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --session requires a value.\n");
  });

  test(`Given resume is passed without a following value,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--resume"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --resume requires a value.\n");
  });

  test(`Given fork is passed without a target session id,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--resume", "demo", "--fork"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --fork requires a value.\n");
  });

  test(`Given fork is passed with an empty equals value,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--resume", "demo", "--fork="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --fork requires a value.\n");
  });

  test(`Given fork is passed without a source session,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--fork", "target"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --fork requires --resume <id>.\n");
  });

  test(`Given fork-before-user is passed without a value,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork",
      "target",
      "--fork-before-user",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-before-user requires a value.\n",
    );
  });

  test(`Given fork-before-user is not a positive integer,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork",
      "target",
      "--fork-before-user=0",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-before-user must be a positive integer.\n",
    );
  });

  test(`Given fork-before-user is passed without a fork target,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-before-user",
      "1",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-before-user requires --resume <id> --fork <new-id>.\n",
    );
  });

  test(`Given fork-points is passed without a source session,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime(["--fork-points"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points requires --resume <id>.\n",
    );
  });

  test(`Given fork-points is combined with a fork target,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-points",
      "--fork",
      "target",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points cannot be combined with --fork.\n",
    );
  });

  test(`Given fork-points is combined with a fork point,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-points",
      "--fork-before-user",
      "1",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points cannot be combined with --fork-before-user.\n",
    );
  });

  test(`Given fork-points is combined with a prompt,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-points",
      "hello",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points cannot be combined with a message.\n",
    );
  });

  test(`Given fork-points is combined with transcript output,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-points",
      "--transcript",
      "out.jsonl",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points cannot be combined with --transcript.\n",
    );
  });

  test(`Given fork-points names a missing source session,
    When the CLI main reads fork points,
    Then it reports the resume error without starting interactive mode`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const fixture = createRuntime(["--resume", "missing", "--fork-points"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        'Error: cannot resume session "missing": session ledger not found at ',
      );
      expect(fixture.stderr()).toContain(
        join(home, "sessions", "missing", "ledger.jsonl"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given session and resume flags are combined,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--session", "demo", "--resume", "demo"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --session cannot be combined with --resume.\n",
    );
  });

  test(`Given a session flag is used with a one-shot prompt,
    When the CLI main parses the request,
    Then it returns a validation error because sessions are interactive-only`, async () => {
    // Given
    const fixture = createRuntime(["--session=demo", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --session and --resume are only supported for interactive sessions.\n",
    );
  });

  test(`Given an unknown eval option,
    When the CLI main parses the eval request,
    Then it returns an eval option validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--wat"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown eval option "--wat"\n');
  });

  test(`Given eval compare has base and head result files,
    When the CLI main runs the compare request,
    Then it prints the comparison report`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-cli-main-eval-compare-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(
      baseFile,
      evalResultLineJson({ taskId: "same-task", trial: 1, pass: true }),
      "utf8",
    );
    await writeFile(
      headFile,
      evalResultLineJson({ taskId: "same-task", trial: 1, pass: true }),
      "utf8",
    );
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base",
      baseFile,
      "--head",
      headFile,
    ]);
    let processStdout = "";
    const writeStdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        processStdout += chunk.toString();
        return true;
      });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe("");
      expect(processStdout).toContain("Eval comparison:\n");
      expect(processStdout).toContain(`base: ${baseFile}\n`);
      expect(processStdout).toContain(`head: ${headFile}\n`);
      expect(processStdout).toContain("task: same-task\n");
      expect(processStdout).toContain("  status: UNCHANGED\n");
    } finally {
      writeStdout.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given eval compare uses equals-style base and head options,
    When the CLI main parses an extra compare option,
    Then it returns a compare option validation error`, async () => {
    // Given
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base=base.jsonl",
      "--head=head.jsonl",
      "--wat",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: unknown eval compare option "--wat"\n',
    );
  });

  test(`Given eval compare has an empty equals-style base option,
    When the CLI main parses the compare request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "compare", "--base="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --base requires a value.\n");
  });

  test(`Given eval compare has an empty equals-style head option,
    When the CLI main parses the compare request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base",
      "base.jsonl",
      "--head=",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --head requires a value.\n");
  });

  test(`Given eval compare has a base option without a following value,
    When the CLI main parses the compare request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "compare", "--base"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --base requires a value.\n");
  });

  test(`Given eval compare has a head option without a following value,
    When the CLI main parses the compare request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base",
      "base.jsonl",
      "--head",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --head requires a value.\n");
  });

  test(`Given eval compare is missing the base result file,
    When the CLI main parses the eval compare request,
    Then it returns a compare option validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "compare", "--head", "head.jsonl"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: eval compare requires --base <file>.\n",
    );
  });

  test(`Given eval compare is missing the head result file,
    When the CLI main parses the eval compare request,
    Then it returns a compare option validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "compare", "--base", "base.jsonl"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: eval compare requires --head <file>.\n",
    );
  });

  test(`Given an eval option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--suite"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --suite requires a value.\n");
  });

  test(`Given an eval output option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--out"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --out requires a value.\n");
  });

  test(`Given an eval transcript directory option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--transcript-dir"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --transcript-dir requires a value.\n",
    );
  });

  test(`Given an eval transcript directory option uses an empty equals value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--transcript-dir="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --transcript-dir requires a value.\n",
    );
  });

  test(`Given an eval task option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--task"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --task requires a value.\n");
  });

  test(`Given an eval provider option is invalid,
    When the CLI main parses the eval request,
    Then it returns a provider validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--provider", "anthropic"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given an inline eval provider option is invalid,
    When the CLI main parses the eval request,
    Then it returns a provider validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--provider=anthropic"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given an eval model option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--model"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given an inline eval model option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--model="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given eval provider and model options are valid,
    When the CLI main dispatches to the eval runner,
    Then it accepts the separated provider selection flags`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-eval-model-"),
    );
    const fixture = createRuntime(
      [
        "eval",
        "--provider",
        "fake",
        "--model",
        "ignored",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given eval provider and model equals options are valid,
    When the CLI main dispatches to the eval runner,
    Then it accepts the inline provider selection flags`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-eval-model-equals-"),
    );
    const fixture = createRuntime(
      [
        "eval",
        "--provider=fake",
        "--model=ignored",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given eval transcript directory uses equals syntax,
    When the CLI main dispatches to the eval runner,
    Then it accepts the inline transcript artifact option`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-eval-transcript-equals-"),
    );
    const fixture = createRuntime(
      [
        "eval",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
        `--transcript-dir=${join(workspace, "transcripts")}`,
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an invalid eval trial count,
    When the CLI main parses the eval request,
    Then it returns a trial validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--trials", "0"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --trials must be a positive integer.\n",
    );
  });

  test(`Given eval options are valid but the suite is missing,
    When the CLI main dispatches to the eval runner,
    Then it returns the eval configuration failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-eval-"));
    const fixture = createRuntime(
      [
        "eval",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
        "--trials",
        "1",
        "--task",
        "fix-note",
        "--transcript-dir",
        join(workspace, "transcripts"),
        "--check",
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given eval runs without a task filter,
    When the CLI main dispatches to the eval runner,
    Then it omits the optional task selection`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-eval-all-"));
    const fixture = createRuntime(
      [
        "eval",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given there is no edit checkpoint,
    When the CLI main dispatches undo,
    Then it returns the user-visible undo failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-undo-"));
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).not.toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user asks for diagnostics,
    When the CLI main dispatches the doctor command,
    Then it returns the diagnostic result`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--provider=fake"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Keel doctor");
    expect(fixture.stdout()).toContain("provider: fake (source: --provider)");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given Qwen fallback API key env is selected for diagnostics with CLI flags,
    When the CLI main dispatches the doctor command,
    Then it reports the fallback key env and default endpoint`, async () => {
    // Given
    const apiKeySecret = "main-doctor-qwen-fallback-secret";
    const fixture = createRuntime(
      [
        "--doctor",
        "--offline",
        "--provider",
        "qwen",
        "--model",
        "qwen3.7-plus",
      ],
      {
        env: {
          KEEL_PROVIDER: "fake",
          QWEN_API_KEY: apiKeySecret,
        },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("provider: qwen (source: --provider)");
    expect(fixture.stdout()).toContain("model: qwen3.7-plus (source: --model)");
    expect(fixture.stdout()).toContain("api key: present (QWEN_API_KEY)");
    expect(fixture.stdout()).toContain(
      "base url: https://dashscope-intl.aliyuncs.com/compatible-mode/v1 (source: default)",
    );
    expect(fixture.stdout()).toContain(
      "context window: 256000 tokens (source: default)",
    );
    expect(fixture.stdout()).toContain("provider auth: skipped (--offline)");
    expect(fixture.stdout()).not.toContain(apiKeySecret);
    expect(fixture.stderr()).toBe("");
  });

  test(`Given Qwen diagnostics use equals flags with an unparseable base URL,
    When the CLI main dispatches the doctor command,
    Then it redacts the base URL value while preserving the source`, async () => {
    // Given
    const fixture = createRuntime(
      ["--doctor", "--offline", "--provider=qwen", "--model=qwen3.7-plus"],
      {
        env: {
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: "not a url with secret-token",
        },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("provider: qwen (source: --provider)");
    expect(fixture.stdout()).toContain("model: qwen3.7-plus (source: --model)");
    expect(fixture.stdout()).toContain(
      "base url: <unparseable URL> (source: QWEN_BASE_URL)",
    );
    expect(fixture.stdout()).toContain("provider auth: skipped (--offline)");
    expect(fixture.stdout()).not.toContain("secret-token");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given a doctor provider flag is missing its value,
    When the CLI main parses the command,
    Then it exits with the provider option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--provider"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --provider requires a value.\n");
  });

  test(`Given a doctor provider equals flag has an empty value,
    When the CLI main parses the command,
    Then it exits with the provider option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--provider="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --provider requires a value.\n");
  });

  test(`Given a doctor model flag is missing its value,
    When the CLI main parses the command,
    Then it exits with the model option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--model"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given a doctor model equals flag has an empty value,
    When the CLI main parses the command,
    Then it exits with the model option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--model="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given an unsupported doctor option,
    When the CLI main parses the command,
    Then it exits with the doctor option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--report", "doctor.json"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown doctor option "--report"\n');
  });

  test(`Given a selected real provider is missing its API key,
    When the CLI main dispatches the doctor command,
    Then it reports the missing provider setting as a failing diagnostic`, async () => {
    // Given
    const fixture = createRuntime(["--doctor"], {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain(
      "provider: deepseek (source: KEEL_PROVIDER)",
    );
    expect(fixture.stdout()).toContain(
      "api key: missing (expected DEEPSEEK_API_KEY)",
    );
    expect(fixture.stdout()).toContain(
      "error: missing API key: expected DEEPSEEK_API_KEY",
    );
    expect(fixture.stderr()).toBe("");
  });

  test(`Given Kimi is configured with unknown pricing,
    When the CLI main dispatches the doctor command,
    Then it reports provider readiness with a cost warning`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--offline"], {
      env: {
        KEEL_PROVIDER: "kimi",
        KIMI_API_KEY: "test-key",
        KIMI_MODEL: "kimi-next",
      },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain(
      "provider: kimi (source: KEEL_PROVIDER)",
    );
    expect(fixture.stdout()).toContain("model: kimi-next (source: KIMI_MODEL)");
    expect(fixture.stdout()).toContain("cost model: unknown");
    expect(fixture.stdout()).toContain(
      "warning: cost tracking is unavailable for model kimi-next",
    );
    expect(fixture.stdout()).toContain("provider auth: skipped (--offline)");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the context window env is invalid for diagnostics,
    When the CLI main dispatches the doctor command,
    Then it reports the invalid context setting as a failing diagnostic`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--provider=fake"], {
      env: { KEEL_CONTEXT_WINDOW_TOKENS: "12px" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain(
      "context window: invalid (source: KEEL_CONTEXT_WINDOW_TOKENS)",
    );
    expect(fixture.stdout()).toContain(
      "error: KEEL_CONTEXT_WINDOW_TOKENS must be a positive integer",
    );
    expect(fixture.stderr()).toBe("");
  });

  test(`Given an unknown provider is configured for diagnostics,
    When the CLI main dispatches the doctor command,
    Then it reports the provider configuration failure`, async () => {
    // Given
    const fixture = createRuntime(["--doctor"], {
      env: { KEEL_PROVIDER: "unknown" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain("provider: failed");
    expect(fixture.stderr()).toBe('Error: unknown provider "unknown"\n');
  });

  test(`Given the last edit checkpoint can be restored,
    When the CLI main dispatches undo,
    Then it restores the file and reports the path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-undo-ok-"));
    await runGit(workspace, ["init"]);
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(fixture.stdout()).toContain("Restored note.txt\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the last edit checkpoint no longer matches the file,
    When the CLI main dispatches undo,
    Then it refuses to overwrite the user's newer changes`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-undo-blocked-"),
    );
    await runGit(workspace, ["init"]);
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    await writeFile(join(workspace, "note.txt"), "newer change\n", "utf8");
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "newer change\n",
      );
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).not.toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
        schemaVersion: 1,
        provider: "fake",
        model: "fake",
        costUsd: 0,
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
  ])(`Given conflicting bash policy options %s %s,
    When the CLI main parses the request,
    Then it returns a conflict validation error`, async (...args) => {
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
  });

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

  test(`Given the configured provider reads a workspace file,
    When the CLI main runs in-process,
    Then it reports the read tool and sends the content back to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-read-"));
    await writeFile(join(workspace, "note.txt"), "hello from note\n", "utf8");
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
          res.write(sseToolCall("call_read", "read", { path: "note.txt" }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Read done."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["read note.txt"], {
      cwd: workspace,
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
      expect(fixture.stdout()).toBe("Read done.\n");
      expect(fixture.stderr()).toBe("Tool: read note.txt\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_read",
        content: "hello from note\n",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider lists a workspace directory,
    When the CLI main runs in-process,
    Then it reports the ls tool and sends the directory entries back to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-ls-"));
    await mkdir(join(workspace, "src", "lib"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "app\n", "utf8");
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
          res.write(sseToolCall("call_ls", "ls", { path: "src" }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("List done."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["list src"], {
      cwd: workspace,
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
      expect(fixture.stdout()).toBe("List done.\n");
      expect(fixture.stderr()).toBe("Tool: ls src\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_ls",
        content: ["lib/", "app.ts"].join("\n"),
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider lists the workspace root,
    When the CLI main runs in-process,
    Then it reports the default ls path and sends root entries back to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-ls-root-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "docs\n", "utf8");
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
          res.write(sseToolCall("call_ls_root", "ls", {}));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Root listed."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["list root"], {
      cwd: workspace,
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
      expect(fixture.stdout()).toBe("Root listed.\n");
      expect(fixture.stderr()).toBe("Tool: ls .\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_ls_root",
        content: ["src/", "README.md"].join("\n"),
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider searches the workspace,
    When the CLI main runs in-process,
    Then it reports the grep tool and sends matches back to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-grep-"));
    await writeFile(
      join(workspace, "app.ts"),
      "export function handleSubmit() {}\n",
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
            sseToolCall("call_grep", "grep", { pattern: "handleSubmit" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Grep done."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["find handleSubmit"], {
      cwd: workspace,
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
      expect(fixture.stdout()).toBe("Grep done.\n");
      expect(fixture.stderr()).toBe("Tool: grep handleSubmit\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_grep",
        content: "app.ts:1:export function handleSubmit() {}",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool label contains terminal control characters,
    When the CLI main reports tool progress,
    Then it escapes the label before writing stderr`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-label-"));
    const unsafePattern = "needle\t\r\n\u202e";
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
            sseToolCall("call_grep", "grep", { pattern: unsafePattern }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Escaped."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["search unsafe label"], {
      cwd: workspace,
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
      expect(fixture.stdout()).toBe("Escaped.\n");
      expect(fixture.stderr()).toBe(
        "Tool: grep needle\\t\\r\\n\\u{202e}\nTool failed: grep needle\\t\\r\\n\\u{202e}\n",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool label is too long and includes a path,
    When the CLI main reports tool progress,
    Then it truncates the single stderr line`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-label-long-"),
    );
    const pattern = "needle".repeat(40);
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
            sseToolCall("call_grep", "grep", {
              pattern,
              path: "missing.txt",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Truncated."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["search long label"], {
      cwd: workspace,
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
      expect(fixture.stdout()).toBe("Truncated.\n");
      const stderrLines = fixture.stderr().trimEnd().split("\n");
      expect(stderrLines).toHaveLength(2);
      expect(stderrLines[0]).toMatch(/^Tool: grep needle/);
      expect(stderrLines[0]).toContain("...");
      expect(stderrLines[0]).toHaveLength("Tool: ".length + 163);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given trusted shell mode is enabled for the configured provider,
    When the CLI main runs in-process,
    Then it reports the bash tool and sends shell output back to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-bash-"));
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
            sseToolCall("call_bash", "bash", { command: "printf shell-ok" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Bash done."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["--allow-bash", "run shell"], {
      cwd: workspace,
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
      expect(fixture.stdout()).toBe("Bash done.\n");
      expect(fixture.stderr()).toBe("Tool: bash printf shell-ok\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_bash",
          content: expect.stringContaining("stdout:\nshell-ok"),
        }),
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given ask bash policy is enabled for a one-shot run,
    When the provider requests a shell command,
    Then the command is denied without changing the workspace`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-bash-ask-"));
    const capturedBodies: unknown[] = [];
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
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
          res.write(sseToolCall("call_bash", "bash", { command }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Shell denied."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["--bash-policy", "ask", "run shell"], {
      cwd: workspace,
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
      expect(fixture.stdout()).toBe("Shell denied.\n");
      expect(fixture.stderr()).toBe(
        `Tool: bash ${command}\nTool failed: bash ${command}\n`,
      );
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_bash",
          content: expect.stringContaining("bash permission denied"),
        }),
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a one-shot provider request is interrupted,
    When the CLI main receives SIGINT,
    Then it aborts the request and returns the interrupted exit code`, async () => {
    // Given
    const sigint: SigintCapture = { handler: null };
    let receiveRequest: () => void = () => {};
    const requestReceived = new Promise<void>((resolve) => {
      receiveRequest = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      receiveRequest();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "partial" } }],
        })}\n\n`,
      );
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      onSigint: (handler) => {
        sigint.handler = handler;
      },
      offSigint: (handler) => {
        if (sigint.handler === handler) sigint.handler = null;
      },
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await requestReceived;
      const handler = sigint.handler;
      if (handler === null) {
        throw new Error("SIGINT handler was not registered");
      }
      handler();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(130);
      expect(fixture.stdout()).toBe("\n");
      expect(fixture.stderr()).toBe("");
      expect(sigint.handler).toBeNull();
    } finally {
      await close(server);
    }
  });

  test.each([
    {
      provider: "deepseek",
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
      stderr:
        "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.\n",
    },
    {
      provider: "kimi",
      env: { KEEL_PROVIDER: "kimi", KIMI_API_KEY: "" },
      stderr: "Error: KIMI_API_KEY is required. Set the API key to use Kimi.\n",
    },
    {
      provider: "qwen",
      env: { KEEL_PROVIDER: "qwen", DASHSCOPE_API_KEY: "" },
      stderr:
        "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.\n",
    },
  ])(`Given $provider is configured without an API key,
    When the CLI main resolves the provider,
    Then it returns the provider-specific API key error`, async ({
    env,
    stderr,
  }) => {
    // Given
    const fixture = createRuntime(["hello"], { env });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(stderr);
  });

  test(`Given the fake provider is selected with a max cost,
    When the CLI main finishes a one-shot request,
    Then it prints the spent cost report`, async () => {
    // Given
    const fixture = createRuntime(["--max-cost", "1", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
  });

  test(`Given DeepSeek is selected with unknown model pricing and a max cost,
    When the CLI main resolves cost tracking,
    Then it rejects the run before calling the provider`, async () => {
    // Given
    const fixture = createRuntime(
      [
        "--max-cost",
        "1",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-unknown",
        "hello",
      ],
      {
        env: { DEEPSEEK_API_KEY: "test-key" },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: cost tracking is only supported for known DeepSeek model pricing; configured --model="deepseek-unknown".\n',
    );
  });

  test(`Given the configured provider exceeds the max cost,
    When the CLI main finishes a one-shot request,
    Then it marks the cost budget as exceeded`, async () => {
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
        res.end(
          sseTextReplyWithUsage("Expensive.", {
            prompt_tokens: 1_000_000_000,
            completion_tokens: 1_000_000_000,
          }),
        );
      });
    });
    await listen(server);
    const fixture = createRuntime(["--max-cost", "0.0001", "hello"], {
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
      expect(fixture.stdout()).toBe("Expensive.\n");
      expect(fixture.stderr()).toContain("exceeded");
    } finally {
      await close(server);
    }
  });

  test.each([
    {
      provider: "kimi",
      env: {
        KEEL_PROVIDER: "kimi",
        KIMI_API_KEY: "test-key",
        KIMI_MODEL: "kimi-k2.5",
      },
      stderr:
        'Error: cost tracking is only supported for Kimi model "kimi-k2.6"; configured KIMI_MODEL="kimi-k2.5".\n',
    },
    {
      provider: "qwen",
      env: {
        KEEL_PROVIDER: "qwen",
        DASHSCOPE_API_KEY: "test-key",
        QWEN_MODEL: "qwen-unknown",
      },
      stderr:
        'Error: cost tracking is only supported for known Qwen model pricing; configured QWEN_MODEL="qwen-unknown".\n',
    },
  ])(`Given $provider has no supported cost model,
    When the CLI main is asked to track cost,
    Then it rejects the run before contacting the provider`, async ({
    env,
    stderr,
  }) => {
    // Given
    const fixture = createRuntime(["--max-cost", "1", "hello"], { env });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(stderr);
  });

  test(`Given the fake provider writes a file,
    When the CLI main runs a one-shot create request,
    Then it writes the file through real tools and reports progress`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-write-"));
    const fixture = createRuntime(["create generated.json"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "generated.json"), "utf8")).toBe(
        '{"created":true}\n',
      );
      expect(fixture.stdout()).toBe("Created generated.json\n");
      expect(fixture.stderr()).toBe("Tool: write generated.json\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    ["replace old new"],
    ["replace old with new"],
    ["replace  with new in note.txt"],
    ["replace old with  in note.txt"],
    ["replace old with new in "],
    ["create "],
  ])(`Given the fake provider receives unsupported demo input "%s",
    When the CLI main runs the request,
    Then it falls back to a plain fake reply`, async (message) => {
    // Given
    const fixture = createRuntime([message], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the fake provider runs interactively,
    When the user sends two prompts on stdin,
    Then the second reply can use the first prompt as context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-no-agents-"));
    const input = new PassThrough();
    input.end("remember alpha\nwhat did I ask you to remember?\n");
    const fixture = createRuntime([], {
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
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user starts and resumes a named interactive session,
    When follow-up prompts are sent after process restart,
    Then the provider receives the prior transcript and persists queued input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n");
    const firstRun = createRuntime(["--session", "demo"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const secondInput = new PassThrough();
      secondInput.end("what did I ask you to remember?\nremember beta\n");
      const secondRun = createRuntime(["--resume=demo"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: secondInput,
      });

      // When
      const secondExitCode = await runCliMain(secondRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(firstRun.stdout()).toBe("Remembered: remember alpha\n");
      expect(secondExitCode).toBe(0);
      expect(secondRun.stdout()).toContain(
        "Earlier you said: remember alpha\n",
      );
      expect(secondRun.stdout()).toContain("Remembered: remember beta\n");
      expect(firstRun.stderr()).toBe("");
      expect(secondRun.stderr()).toBe("");
      const ledgerLines = (
        await readFile(join(home, "sessions", "demo", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const admittedInput = ledgerLines.find(
        (line) => line.type === "input_admitted",
      );
      expect(admittedInput).toMatchObject({
        type: "input_admitted",
        line: "remember beta",
      });
      const consumingAppend = ledgerLines.find((line) =>
        Array.isArray(line.consumedInputIds),
      );
      expect(consumingAppend).toMatchObject({
        type: "append",
        consumedInputIds: [admittedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session approved a bash command for the session,
    When the user resumes and the provider repeats that command,
    Then the resumed CLI run executes it without another approval prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-bash-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      requestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1 || requestCount === 3) {
        res.write(
          sseToolCall(`call_bash_${requestCount}`, "bash", { command }),
        );
        res.write(sseToolFinish());
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.end(
        sseTextReplyWithUsage(
          requestCount === 2 ? "First bash done." : "Second bash done.",
        ),
      );
    });
    await listen(server);

    const firstInput = new PassThrough();
    Object.defineProperty(firstInput, "isTTY", { value: true });
    let firstApprovalPrompts = 0;
    let resolveFirstApprovalPrompt: () => void = () => {};
    const firstApprovalPrompt = new Promise<void>((resolve) => {
      resolveFirstApprovalPrompt = resolve;
    });
    const firstRun = createRuntime(
      ["--session", "bash-resume", "--bash-policy", "ask"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
        input: firstInput,
        onStderr: (text) => {
          if (text.includes("Approve bash command")) {
            firstApprovalPrompts++;
            resolveFirstApprovalPrompt();
          }
        },
      },
    );

    try {
      const firstRunPromise = runCliMain(firstRun.runtime);
      firstInput.write("run bash\n");
      await withTimeout(
        firstApprovalPrompt,
        5000,
        "first bash approval prompt was not shown",
      );
      firstInput.write("s\n");
      firstInput.end();
      const firstExitCode = await withTimeout(
        firstRunPromise,
        5000,
        "first bash approval run did not finish",
      );

      const secondInput = new PassThrough();
      Object.defineProperty(secondInput, "isTTY", { value: true });
      let secondApprovalPrompts = 0;
      const secondRun = createRuntime(
        ["--resume", "bash-resume", "--bash-policy", "ask"],
        {
          cwd: workspace,
          env: {
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
            KEEL_HOME: home,
          },
          input: secondInput,
          onStderr: (text) => {
            if (text.includes("Approve bash command")) {
              secondApprovalPrompts++;
            }
          },
        },
      );

      // When
      const secondRunPromise = runCliMain(secondRun.runtime);
      secondInput.end("run bash again\n");
      const secondExitCode = await withTimeout(
        secondRunPromise,
        5000,
        "second resumed bash run did not finish",
      );

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(0);
      expect(firstApprovalPrompts).toBe(1);
      expect(secondApprovalPrompts).toBe(0);
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
      expect(firstRun.stdout()).toBe("First bash done.\n");
      expect(secondRun.stdout()).toBe("Second bash done.\n");
      const ledger = await readFile(
        join(home, "sessions", "bash-resume", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"type":"bash_approval_granted"');
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has queued input from an interrupted process,
    When the user resumes with no new stdin,
    Then the queued input runs once and is marked consumed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await mkdir(join(home, "sessions", "queued"), { recursive: true });
    await writeFile(
      join(home, "sessions", "queued", "ledger.jsonl"),
      `${[
        JSON.stringify({
          schemaVersion: 1,
          type: "session",
          id: "queued",
          createdAt: "1970-01-01T00:00:00.000Z",
          workspace: ledgerWorkspace,
        }),
        JSON.stringify({
          schemaVersion: 1,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.001Z",
          id: "queued-input-1",
          sequence: 2,
          line: "remember queued",
        }),
      ].join("\n")}\n`,
      "utf8",
    );
    const input = new PassThrough();
    input.end();
    const fixture = createRuntime(["--resume", "queued"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Remembered: remember queued\n");
      expect(fixture.stderr()).toBe("");
      const ledgerLines = (
        await readFile(join(home, "sessions", "queued", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines[2]).toMatchObject({
        type: "append",
        consumedInputIds: ["queued-input-1"],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has completed history and queued future input,
    When the user forks it into a new session,
    Then the fork continues from history without consuming the source's queued input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n");
    const firstRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const sourceLedgerPath = join(home, "sessions", "source", "ledger.jsonl");
      await writeFile(
        sourceLedgerPath,
        `${JSON.stringify({
          schemaVersion: 1,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.001Z",
          id: "queued-source-input",
          sequence: 2,
          line: "remember queued",
        })}\n`,
        { encoding: "utf8", flag: "a" },
      );
      const forkInput = new PassThrough();
      forkInput.end("what did I ask you to remember?\n");
      const forkRun = createRuntime(["--resume=source", "--fork=target"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: forkInput,
      });

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe("Earlier you said: remember alpha\n");
      expect(forkRun.stderr()).toBe("");
      const sourceLedgerLines = (await readFile(sourceLedgerPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        sourceLedgerLines.some(
          (line) =>
            Array.isArray(line.consumedInputIds) &&
            line.consumedInputIds.includes("queued-source-input"),
        ),
      ).toBe(false);
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        forkedFrom: "source",
      });
      expect(
        targetLedgerLines.some(
          (line) =>
            line.type === "input_admitted" && line.line === "remember queued",
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has multiple completed prompts,
    When the user forks it before a restored user message,
    Then the fork continues from the earlier history only`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\nremember beta\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const forkInput = new PassThrough();
      forkInput.end("what did I ask you to remember?\n");
      const forkRun = createRuntime(
        ["--resume", "source", "--fork", "target", "--fork-before-user=2"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: forkInput,
        },
      );

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe("Earlier you said: remember alpha\n");
      expect(forkRun.stderr()).toBe("");
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        forkedFrom: "source",
      });
      const forkedHistory = targetLedgerLines.find(
        (line) => line.type === "append",
      );
      expect(forkedHistory).toMatchObject({
        type: "append",
        messages: [
          { role: "user", content: "remember alpha" },
          { role: "assistant", content: "Remembered: remember alpha" },
        ],
      });
      expect(JSON.stringify(forkedHistory)).not.toContain("remember beta");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has multiple completed prompts,
    When the user lists fork points for that session,
    Then the CLI shows the restored user message numbers and matching fork commands`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const longPrompt = `remember ${"0123456789".repeat(14)}`;
    const longPromptPreview = `${longPrompt.slice(0, 117)}...`;
    const sourceInput = new PassThrough();
    sourceInput.end(`remember alpha\n${longPrompt}\n`);
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });
    const listRun = createRuntime(["--resume", "source", "--fork-points"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);

      // When
      const listExitCode = await runCliMain(listRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(listExitCode).toBe(0);
      expect(listRun.stdout()).toBe(
        [
          'Fork points for session "source":',
          "1. remember alpha",
          "   use: keel --resume source --fork <new-id> --fork-before-user 1",
          `2. ${longPromptPreview}`,
          "   use: keel --resume source --fork <new-id> --fork-before-user 2",
          "",
        ].join("\n"),
      );
      expect(listRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has no restored user messages,
    When the user lists fork points for that session,
    Then the CLI reports that no fork points are available`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionDir = join(home, "sessions", "empty");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "ledger.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        type: "session",
        id: "empty",
        createdAt: "1970-01-01T00:00:00.000Z",
        workspace: await realpath(workspace),
      })}\n`,
      "utf8",
    );
    const listRun = createRuntime(["--resume", "empty", "--fork-points"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const listExitCode = await runCliMain(listRun.runtime);

      // Then
      expect(listExitCode).toBe(0);
      expect(listRun.stdout()).toBe(
        'No restored user messages in session "empty".\n',
      );
      expect(listRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given no persisted sessions for the current workspace,
    When the user lists sessions,
    Then the CLI reports an empty catalog without contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "deepseek",
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe(
        `No sessions for workspace ${await realpath(workspace)}.\n`,
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an unsupported sessions option,
    When the user lists sessions,
    Then the CLI exits with a validation error`, async () => {
    // Given
    const fixture = createRuntime(["sessions", "--all"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown sessions option "--all"\n');
  });

  test(`Given persisted sessions exist across workspaces,
    When the user lists sessions,
    Then the CLI shows only current workspace sessions with previews and resume commands`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const otherWorkspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const otherLedgerWorkspace = await realpath(otherWorkspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const longPrompt = `remember ${"0123456789".repeat(14)}`;
    const longPromptPreview = `${longPrompt.slice(0, 117)}...`;
    await writeSessionLedger({
      home,
      id: "long-preview",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-04T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-04T00:00:05.000Z", [
          { role: "user", content: longPrompt },
          {
            role: "assistant",
            content: "Remembered long prompt.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "older",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          { role: "user", content: "remember alpha" },
          {
            role: "assistant",
            content: "Remembered alpha.",
            toolCalls: [],
          },
        ]),
        appendSessionRecordLine("2026-01-01T00:00:06.000Z", [
          { role: "user", content: "remember alpha later" },
          {
            role: "assistant",
            content: "Remembered later alpha.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "forked",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      forkedFrom: "older",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          { role: "user", content: "remember beta\nwith spacing" },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "compacted",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T18:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T18:00:01.000Z", [
          { role: "user", content: "old compacted prompt" },
          {
            role: "assistant",
            content: "Old compacted answer.",
            toolCalls: [],
          },
        ]),
        replaceSessionRecordLine("2026-01-01T18:00:02.000Z", [
          {
            role: "user",
            content: conversationCheckpoint("Old task summarized."),
          },
          { role: "user", content: "remember compacted" },
          {
            role: "assistant",
            content: "Remembered compacted.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "checkpoint-only",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T18:30:00.000Z",
      records: [
        replaceSessionRecordLine("2026-01-01T18:30:02.000Z", [
          {
            role: "user",
            content: conversationCheckpoint(
              "Only checkpoint summary remains.",
              true,
            ),
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "snapshotted",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T17:00:00.000Z",
      records: [
        snapshotSessionRecordLine("2026-01-01T17:00:02.000Z", [
          { role: "user", content: "remember snapshot" },
          {
            role: "assistant",
            content: "Remembered snapshot.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "queued",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T16:00:00.000Z",
      records: [
        inputAdmittedRecordLine({
          timestamp: "2026-01-01T16:00:01.000Z",
          id: "queued-catalog-input",
          line: "remember queued",
        }),
        inputConsumedRecordLine("2026-01-01T16:00:02.000Z", [
          "queued-catalog-input",
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "tie-a",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T15:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T15:00:01.000Z", [
          { role: "user", content: "remember tie a" },
          {
            role: "assistant",
            content: "Remembered tie a.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "tie-b",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T15:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T15:00:01.000Z", [
          { role: "user", content: "remember tie b" },
          {
            role: "assistant",
            content: "Remembered tie b.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "empty",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T12:00:00.000Z",
    });
    await writeSessionLedger({
      home,
      id: "elsewhere",
      workspace: otherLedgerWorkspace,
      createdAt: "2026-01-03T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-03T00:00:05.000Z", [
          { role: "user", content: "do not show this session" },
          {
            role: "assistant",
            content: "Hidden.",
            toolCalls: [],
          },
        ]),
      ],
    });
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe(
        [
          `Sessions for workspace ${ledgerWorkspace}:`,
          "long-preview  updated 2026-01-04T00:00:05.000Z",
          `   preview: ${longPromptPreview}`,
          "   resume: keel --resume long-preview",
          "   fork-points: keel --resume long-preview --fork-points",
          "   fork: keel --resume long-preview --fork <new-id>",
          "forked  updated 2026-01-02T00:00:05.000Z",
          "   forked from: older",
          "   preview: remember beta with spacing",
          "   resume: keel --resume forked",
          "   fork-points: keel --resume forked --fork-points",
          "   fork: keel --resume forked --fork <new-id>",
          "checkpoint-only  updated 2026-01-01T18:30:02.000Z",
          "   preview: checkpoint: Only checkpoint summary remains.",
          "   resume: keel --resume checkpoint-only",
          "   fork-points: keel --resume checkpoint-only --fork-points",
          "   fork: keel --resume checkpoint-only --fork <new-id>",
          "compacted  updated 2026-01-01T18:00:02.000Z",
          "   preview: remember compacted",
          "   resume: keel --resume compacted",
          "   fork-points: keel --resume compacted --fork-points",
          "   fork: keel --resume compacted --fork <new-id>",
          "snapshotted  updated 2026-01-01T17:00:02.000Z",
          "   preview: remember snapshot",
          "   resume: keel --resume snapshotted",
          "   fork-points: keel --resume snapshotted --fork-points",
          "   fork: keel --resume snapshotted --fork <new-id>",
          "queued  updated 2026-01-01T16:00:02.000Z",
          "   preview: (no restored user messages)",
          "   resume: keel --resume queued",
          "   fork-points: keel --resume queued --fork-points",
          "   fork: keel --resume queued --fork <new-id>",
          "tie-a  updated 2026-01-01T15:00:01.000Z",
          "   preview: remember tie a",
          "   resume: keel --resume tie-a",
          "   fork-points: keel --resume tie-a --fork-points",
          "   fork: keel --resume tie-a --fork <new-id>",
          "tie-b  updated 2026-01-01T15:00:01.000Z",
          "   preview: remember tie b",
          "   resume: keel --resume tie-b",
          "   fork-points: keel --resume tie-b --fork-points",
          "   fork: keel --resume tie-b --fork <new-id>",
          "empty  updated 2026-01-01T12:00:00.000Z",
          "   preview: (no restored user messages)",
          "   resume: keel --resume empty",
          "   fork-points: keel --resume empty --fork-points",
          "   fork: keel --resume empty --fork <new-id>",
          "older  updated 2026-01-01T00:00:06.000Z",
          "   preview: remember alpha",
          "   resume: keel --resume older",
          "   fork-points: keel --resume older --fork-points",
          "   fork: keel --resume older --fork <new-id>",
          "",
        ].join("\n"),
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(otherWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given restored session messages do not contain user prompts,
    When the user lists sessions,
    Then the CLI falls back to an empty user preview`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const malformedCheckpoint = conversationCheckpoint(
      "Malformed checkpoint should be treated as ordinary user text.",
    ).replace("<summary>", "<body>");
    const malformedCheckpointPreview = `${malformedCheckpoint
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 117)}...`;
    await writeSessionLedger({
      home,
      id: "malformed-checkpoint",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T18:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T18:00:01.000Z", [
          { role: "user", content: malformedCheckpoint },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "assistant-only",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T17:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T17:00:01.000Z", [
          {
            role: "assistant",
            content: "No restored user prompt.",
            toolCalls: [],
          },
        ]),
      ],
    });
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe(
        [
          `Sessions for workspace ${ledgerWorkspace}:`,
          "malformed-checkpoint  updated 2026-01-01T18:00:01.000Z",
          `   preview: ${malformedCheckpointPreview}`,
          "   resume: keel --resume malformed-checkpoint",
          "   fork-points: keel --resume malformed-checkpoint --fork-points",
          "   fork: keel --resume malformed-checkpoint --fork <new-id>",
          "assistant-only  updated 2026-01-01T17:00:01.000Z",
          "   preview: (no restored user messages)",
          "   resume: keel --resume assistant-only",
          "   fork-points: keel --resume assistant-only --fork-points",
          "   fork: keel --resume assistant-only --fork <new-id>",
          "",
        ].join("\n"),
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one session ledger is damaged,
    When the user lists sessions,
    Then the CLI warns and still shows the valid sessions`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "good",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:01.000Z", [
          { role: "user", content: "remember good" },
          {
            role: "assistant",
            content: "Remembered good.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "broken",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: ["not json"],
    });
    await writeSessionLedger({
      home,
      id: "mismatched",
      headerId: "other-session",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("good  updated");
      expect(fixture.stdout()).toContain("   preview: remember good\n");
      expect(fixture.stdout()).not.toContain("broken  updated");
      expect(fixture.stderr()).toContain(
        'Warning: skipped session "broken": cannot load session ledger',
      );
      expect(fixture.stderr()).toContain("line 2 is not valid JSON");
      expect(fixture.stderr()).toContain(
        'Warning: skipped session "mismatched": ledger belongs to session "other-session", not "mismatched".',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session catalog storage cannot be scanned,
    When the user lists sessions,
    Then the CLI reports the catalog load failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sessionsPath = join(home, "sessions");
    await writeFile(sessionsPath, "not a directory", "utf8");
    const fixture = createRuntime(["sessions"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        `Error: cannot list sessions at ${sessionsPath}:`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a fork point is beyond the restored user messages,
    When the user forks a source session at that point,
    Then the CLI fails before creating the target ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const forkInput = new PassThrough();
      forkInput.end("what did I ask you to remember?\n");
      const forkRun = createRuntime(
        ["--resume", "source", "--fork", "target", "--fork-before-user", "2"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: forkInput,
        },
      );

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(1);
      expect(forkRun.stdout()).toBe("");
      expect(forkRun.stderr()).toBe(
        'Error: cannot fork session "target": --fork-before-user 2 exceeds restored user message count 1.\n',
      );
      await expect(
        access(join(home, "sessions", "target", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the fork target session already exists,
    When the user forks a source session into that target,
    Then the CLI fails without overwriting the target ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember source\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });
    const targetInput = new PassThrough();
    targetInput.end("remember target\n");
    const targetRun = createRuntime(["--session", "target"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: targetInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const targetExitCode = await runCliMain(targetRun.runtime);
      const targetLedgerPath = join(home, "sessions", "target", "ledger.jsonl");
      const targetLedgerBefore = await readFile(targetLedgerPath, "utf8");
      const forkInput = new PassThrough();
      forkInput.end("what did I ask you to remember?\n");
      const forkRun = createRuntime(
        ["--resume", "source", "--fork", "target"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: forkInput,
        },
      );

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(targetExitCode).toBe(0);
      expect(forkExitCode).toBe(1);
      expect(forkRun.stdout()).toBe("");
      expect(forkRun.stderr()).toBe(
        'Error: session "target" already exists. Use --resume target to continue it.\n',
      );
      expect(await readFile(targetLedgerPath, "utf8")).toBe(targetLedgerBefore);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the fork source session is already active,
    When the user forks it into a new session,
    Then the CLI fails before creating the target ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const activeLock = acquireSessionLock({
      sessionId: "source",
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
    });
    const input = new PassThrough();
    input.end("what did I ask you to remember?\n");
    const fixture = createRuntime(["--resume", "source", "--fork", "target"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        'Error: session "source" is already active. Stop the other Keel process before using it again.\n',
      );
      await expect(
        access(join(home, "sessions", "target", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      activeLock.release();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user resumes an oversized session with a bounded snapshot,
    When queued input is restored from that snapshot,
    Then the CLI runs it against the snapshotted transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const ledgerPath = join(
      home,
      "sessions",
      "snapshot-queued",
      "ledger.jsonl",
    );
    await mkdir(join(home, "sessions", "snapshot-queued"), {
      recursive: true,
    });
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        type: "session",
        id: "snapshot-queued",
        createdAt: "1970-01-01T00:00:00.000Z",
        workspace: ledgerWorkspace,
      })}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await writeFile(
      ledgerPath,
      `\n${JSON.stringify({
        schemaVersion: 1,
        type: "snapshot",
        timestamp: "1970-01-01T00:00:00.001Z",
        reason: "size_threshold",
        messages: [
          { role: "user", content: "remember alpha" },
          {
            role: "assistant",
            content: "Remembered: remember alpha",
            toolCalls: [],
          },
        ],
        pendingInputs: [
          {
            id: "snapshot-question",
            timestamp: "1970-01-01T00:00:00.002Z",
            sequence: 2,
            line: "what did I ask you to remember?",
          },
        ],
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );
    const input = new PassThrough();
    input.end();
    const fixture = createRuntime(["--resume", "snapshot-queued"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Earlier you said: remember alpha\n");
      expect(fixture.stderr()).toBe("");
      const ledger = await readFile(ledgerPath, "utf8");
      expect(ledger).toContain('"consumedInputIds":["snapshot-question"]');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session receives multiple prompts,
    When the prompts complete in one process,
    Then all completed turns are persisted to the same ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end("remember beta\nwhat did I ask you to remember?\n");
    const fixture = createRuntime(["--session", "multi-turn"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Remembered: remember beta\n");
      expect(fixture.stdout()).toContain("Earlier you said: remember beta\n");
      const ledger = await readFile(
        join(home, "sessions", "multi-turn", "ledger.jsonl"),
        "utf8",
      );
      const ledgerLines = ledger
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines).toHaveLength(4);
      const admittedInput = ledgerLines.find(
        (line) => line.type === "input_admitted",
      );
      expect(admittedInput).toMatchObject({
        type: "input_admitted",
        line: "what did I ask you to remember?",
      });
      const consumingAppend = ledgerLines.find((line) =>
        Array.isArray(line.consumedInputIds),
      );
      expect(consumingAppend).toMatchObject({
        type: "append",
        consumedInputIds: [admittedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session is already active,
    When another interactive process resumes the same session,
    Then the CLI fails before reading prompts or writing a ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const activeLock = acquireSessionLock({
      sessionId: "active",
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
    });
    const input = new PassThrough();
    input.end("remember should-not-run\n");
    const fixture = createRuntime(["--resume", "active"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        'Error: session "active" is already active. Stop the other Keel process before using it again.\n',
      );
      await expect(
        access(join(home, "sessions", "active", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      activeLock.release();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user resumes a malformed session,
    When the CLI main starts,
    Then it fails closed before reading an interactive prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await mkdir(join(home, "sessions", "broken"), { recursive: true });
    await writeFile(
      join(home, "sessions", "broken", "ledger.jsonl"),
      [
        JSON.stringify({
          schemaVersion: 1,
          type: "session",
          id: "broken",
          createdAt: "1970-01-01T00:00:00.000Z",
          workspace,
        }),
        "{not-json",
      ].join("\n"),
      "utf8",
    );
    const input = new PassThrough();
    input.end("this should not run\n");
    const fixture = createRuntime(["--resume", "broken"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        'Error: cannot resume session "broken"',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user resumes a session ledger larger than the resume cap,
    When the CLI main starts,
    Then it reports recovery guidance before parsing the ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const ledgerPath = join(home, "sessions", "huge", "ledger.jsonl");
    await mkdir(join(home, "sessions", "huge"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        type: "session",
        id: "huge",
        createdAt: "1970-01-01T00:00:00.000Z",
        workspace,
      })}\n{not-json`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    const input = new PassThrough();
    input.end("this should not run\n");
    const fixture = createRuntime(["--resume", "huge"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        `Error: cannot resume session "huge": cannot load session ledger ${ledgerPath}: ledger is too large to resume safely`,
      );
      expect(fixture.stderr()).toContain(
        "33,554,433 bytes; limit 33,554,432 bytes",
      );
      expect(fixture.stderr()).toContain(
        "Start a new session with --session <new-id>",
      );
      expect(fixture.stderr()).not.toContain("not valid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user runs interactive mode without a session flag,
    When the prompt completes,
    Then no persistent session is created implicitly`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime([], {
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Remembered: hello\n");
      await expect(access(join(home, "sessions"))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user runs a one-shot prompt,
    When the prompt completes,
    Then no persistent session is required`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const fixture = createRuntime(["hello"], {
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      await expect(access(join(home, "sessions"))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS instructions exist,
    When the user sends an interactive prompt through CLI main,
    Then the provider receives those project instructions in the system prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-agents-"));
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Prefer BDD tests before production changes.\n",
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
        res.end(sseTextReplyWithUsage("Done."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("fix the bug\n");
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Done.\n");
      expect(fixture.stderr()).toBe("");
      const request = requestWithMessagesSchema.parse(capturedBodies[0]);
      const system = request.messages?.find(
        (message) => message.role === "system",
      );
      if (system === undefined) {
        throw new Error("provider request had no system message");
      }
      expect(system.content).toContain("Project instructions from AGENTS.md");
      expect(system.content).toContain(
        "> Prefer BDD tests before production changes.",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS escapes the workspace through a symlink,
    When the CLI main starts an interactive run,
    Then it returns the project instructions error before reading input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-agents-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-cli-main-outside-"));
    await writeFile(join(outside, "secret.txt"), "SECRET_OUTSIDE_WORKSPACE");
    await symlink(join(outside, "secret.txt"), join(workspace, "AGENTS.md"));
    const fixture = createRuntime([], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
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

  test(`Given interactive mode has cost tracking enabled,
    When the user sends one prompt,
    Then the CLI main prints the turn cost report`, async () => {
    // Given
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime(["--max-cost", "1"], {
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Remembered: hello\n");
    expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
  });

  test(`Given an interactive session is idle,
    When the CLI main receives SIGINT,
    Then it closes the session as interrupted`, async () => {
    // Given
    const input = new PassThrough();
    const sigint: SigintCapture = { handler: null };
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
      onSigint: (handler) => {
        sigint.handler = handler;
      },
      offSigint: (handler) => {
        if (sigint.handler === handler) sigint.handler = null;
      },
    });

    // When
    const run = runCliMain(fixture.runtime);
    const handler = sigint.handler;
    if (handler === null) {
      throw new Error("SIGINT handler was not registered");
    }
    handler();
    const exitCode = await run;

    // Then
    expect(exitCode).toBe(130);
    expect(fixture.stdout()).toBe("\n");
    expect(fixture.stderr()).toBe("");
    expect(sigint.handler).toBeNull();
  });

  test(`Given interactive mode resolves a provider configuration error,
    When the user sends a prompt,
    Then the CLI main returns the user-facing error`, async () => {
    // Given
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime([], {
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
      },
      input,
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.\n",
    );
  });

  test(`Given a named session fails before the first completed turn,
    When the provider configuration is invalid,
    Then the CLI main does not create an empty session ledger`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime(["--session", "provider-fails"], {
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.\n",
      );
      await expect(
        access(join(home, "sessions", "provider-fails", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a one-shot run asks for a machine-readable report,
    When the CLI main completes through the fake provider,
    Then it writes the run report from the in-process boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-report-"));
    const reportPath = join(workspace, "run.json");
    const fixture = createRuntime(["--report", reportPath, "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report).toMatchObject({
        schemaVersion: 1,
        provider: "fake",
        model: "fake",
        costUsd: 0,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given max cost and report are passed with equals syntax,
    When the CLI main completes the one-shot run,
    Then it honors both options`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-equals-"));
    const reportPath = join(workspace, "run.json");
    const fixture = createRuntime(
      [`--max-cost=1`, `--report=${reportPath}`, "hello"],
      {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report).toMatchObject({ provider: "fake", costUsd: 0 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider edits a file,
    When the CLI main runs in-process with a workspace,
    Then the user-visible file behavior still goes through real tools`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const fixture = createRuntime(["replace old with new in note.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(fixture.stdout()).toBe("Edited note.txt\n");
      expect(fixture.stderr()).toBe(
        "Tool: read note.txt\nTool: edit note.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider requests an edit that cannot apply,
    When the CLI main runs the tool call,
    Then it reports the failed tool result without crashing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-edit-fail-"));
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    const fixture = createRuntime(["replace old with new in note.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello world\n",
      );
      expect(fixture.stdout()).toContain("Tool failed:");
      expect(fixture.stderr()).toBe(
        "Tool: read note.txt\nTool: edit note.txt\nTool failed: edit note.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider cannot read the edit target,
    When the CLI main runs the tool call,
    Then it reports the failed read result without crashing`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-edit-missing-"),
    );
    const fixture = createRuntime(["replace old with new in missing.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Tool failed:");
      expect(fixture.stdout()).toContain("file not found");
      expect(fixture.stderr()).toBe(
        "Tool: read missing.txt\nTool failed: read missing.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider requests a write that cannot apply,
    When the CLI main runs the tool call,
    Then it reports the failed write result without crashing`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-write-fail-"),
    );
    await writeFile(join(workspace, "note.txt"), "already exists\n", "utf8");
    const fixture = createRuntime(["create note.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "already exists\n",
      );
      expect(fixture.stdout()).toContain("Tool failed:");
      expect(fixture.stderr()).toBe(
        "Tool: write note.txt\nTool failed: write note.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive turn uses the default provider without an API key,
    When the CLI main runs in-process,
    Then it reports the provider configuration error`, async () => {
    // Given
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: { KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    // When
    const run = runCliMain(fixture.runtime);
    input.write("hello\n");
    input.end();
    const exitCode = await run;

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.\n",
    );
  });

  test(`Given Qwen is configured with only QWEN_API_KEY,
    When the CLI main runs in-process,
    Then the provider key fallback is used`, async () => {
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
        res.end(sseTextReplyWithUsage("Qwen fallback."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        KEEL_PROVIDER: "qwen",
        QWEN_API_KEY: "test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Qwen fallback.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await close(server);
    }
  });

  test(`Given provider and model flags override provider env,
    When the CLI main runs in-process,
    Then the selected model is sent to the provider`, async () => {
    // Given
    let capturedModel: string | undefined;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        capturedModel = requestModelSchema.parse(JSON.parse(body)).model;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Selected Qwen."));
      });
    });
    await listen(server);
    const fixture = createRuntime(
      ["--provider", "qwen", "--model", "qwen3.7-plus", "hello"],
      {
        env: {
          KEEL_PROVIDER: "fake",
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Selected Qwen.\n");
      expect(fixture.stderr()).toBe("");
      expect(capturedModel).toBe("qwen3.7-plus");
    } finally {
      await close(server);
    }
  });

  test(`Given Kimi is configured without a model override,
    When the CLI main runs in-process,
    Then the default Kimi model configuration is used`, async () => {
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
        res.end(sseTextReplyWithUsage("Kimi default."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        KEEL_PROVIDER: "kimi",
        KIMI_API_KEY: "test-key",
        KIMI_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Kimi default.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await close(server);
    }
  });
});
