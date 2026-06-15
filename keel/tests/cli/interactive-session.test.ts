import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runInteractiveSession } from "../../src/cli/interactive-session.ts";
import type { CostModel } from "../../src/core/cost.ts";
import type { LLMProvider, Usage } from "../../src/llm/types.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

const ZERO_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

class ForcedExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`forced exit ${code}`);
    this.code = code;
  }
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

describe("Interactive Session", () => {
  test(`Given the interactive session is idle,
    When user interrupts,
    Then the session exits as interrupted`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let exitCode: number | undefined;
    const session = runInteractiveSession({
      cliArgs: { allowBash: false },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: (code) => {
        exitCode = code;
      },
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("idle interrupt should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    for (const handler of [...sigintHandlers]) {
      handler();
    }

    // Then
    await session;
    expect(stdout).toBe("\n");
    expect(exitCode).toBe(130);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive turn has cost tracking,
    When the turn completes,
    Then the session prints the cost report`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { allowBash: true, maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "Cost: $0\n",
    });

    // When
    input.write("hello\n");
    input.end();

    // Then
    await session;
    expect(stderr).toBe("Cost: $0\n");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interrupted interactive turn throws after abort,
    When the abort is already active,
    Then the session treats it as a cancelled turn`, async () => {
    // Given
    let receiveText: () => void = () => {};
    const textReceived = new Promise<void>((resolve) => {
      receiveText = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        yield { type: "text", text: "Working" };
        await new Promise<void>((resolve) => {
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("provider ignored abort before throwing");
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { allowBash: false },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            receiveText();
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("hello\n");
    await withTimeout(textReceived, 5000, "turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Working\n");
  });

  test(`Given an active interactive turn fails without abort,
    When the provider error reaches the session,
    Then the error is rethrown`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "Before failure" };
        throw new Error("provider failed");
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { allowBash: false },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const _event of stream) {
          // Consume the stream so provider errors surface through the session.
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("hello\n");
    input.end();

    // Then
    await expect(session).rejects.toThrow("provider failed");
  });

  test(`Given an active interactive turn has already been interrupted,
    When user interrupts the still-running turn again,
    Then the CLI exits as interrupted`, async () => {
    // Given
    let releaseHang: () => void = () => {};
    let receiveHanging: () => void = () => {};
    let receiveAbort: () => void = () => {};
    let receiveAbortMarker: () => void = () => {};
    const hangReleased = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    const hangingReceived = new Promise<void>((resolve) => {
      receiveHanging = resolve;
    });
    const abortReceived = new Promise<void>((resolve) => {
      receiveAbort = resolve;
    });
    const abortMarkerReceived = new Promise<void>((resolve) => {
      receiveAbortMarker = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        yield { type: "text", text: "Hanging" };
        await new Promise<void>((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              receiveAbort();
              resolve();
            },
            { once: true },
          );
        });
        yield { type: "text", text: " Aborted" };
        await hangReleased;
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const printAgentEvents = async (stream: AsyncIterable<AgentEvent>) => {
      let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
      for await (const event of stream) {
        if (event.type === "text") {
          stdout += event.text;
          if (stdout.includes("Hanging")) {
            receiveHanging();
          }
          if (stdout.includes("Hanging Aborted")) {
            receiveAbortMarker();
          }
        } else if (event.type === "end") {
          finalEnd = event;
        }
      }
      return finalEnd;
    };
    const session = runInteractiveSession({
      cliArgs: { allowBash: false },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: (code) => {
        exitCode = code;
      },
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents,
      formatCostReport: () => "",
    });
    const emitSigint = () => {
      for (const handler of [...sigintHandlers]) {
        handler();
      }
    };

    try {
      // When
      input.write("hang\n");
      await withTimeout(
        hangingReceived,
        5000,
        "interactive session did not start the hanging turn",
      );
      emitSigint();
      await withTimeout(
        abortReceived,
        5000,
        "interactive session did not deliver the first interrupt",
      );
      await withTimeout(
        abortMarkerReceived,
        5000,
        "interactive session did not print the first interrupt marker",
      );

      // Then
      let forcedExit: ForcedExit | null = null;
      try {
        emitSigint();
      } catch (error) {
        if (error instanceof ForcedExit) {
          forcedExit = error;
        } else {
          throw error;
        }
      }
      expect(forcedExit?.code).toBe(130);
      expect(exitCode).toBeUndefined();
      expect(stdout).toBe("Hanging Aborted\n");
      expect(stderr).toBe("");
    } finally {
      releaseHang();
      input.end();
      await session;
    }
  });
});
