import { createFakeProvider, fakeResponse } from "../llm/providers/fake.ts";
import type { LLMProvider } from "../llm/types.ts";

interface CliEditRequest {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

interface CliWriteRequest {
  readonly path: string;
  readonly content: string;
}

interface CliPatchRequest {
  readonly readPath: string;
  readonly patch: string;
}

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

function createObservedFakeProvider(
  stream: LLMProvider["stream"],
): LLMProvider {
  return {
    id: "fake",
    async *stream(options) {
      const attempt = options.providerRequestAttempts?.begin();
      let finished = false;
      try {
        for await (const event of stream(options)) {
          if (event.type === "stop") {
            finished = true;
            attempt?.finish({ outcome: "completed", usage: event.usage });
          }
          yield event;
        }
        /* v8 ignore start -- demo scripts complete normally; production fake/provider conformance owns error and consumer-cancellation attempt finalization. */
      } catch (error) {
        if (!finished) {
          finished = true;
          attempt?.finish(
            options.signal.aborted
              ? { outcome: "aborted" }
              : {
                  outcome: "terminal_error",
                  errorCode: "provider_unexpected_error",
                },
          );
        }
        throw error;
      } finally {
        if (!finished) {
          finished = true;
          attempt?.finish(
            options.signal.aborted
              ? { outcome: "aborted" }
              : {
                  outcome: "terminal_error",
                  errorCode: "provider_consumer_closed",
                },
          );
        }
      }
      /* v8 ignore stop */
    },
  };
}

function parseCliEditDemo(message: string): CliEditRequest | null {
  const prefix = "replace ";
  const withToken = " with ";
  const inToken = " in ";

  if (!message.startsWith(prefix)) return null;

  const body = message.slice(prefix.length);
  const withIndex = body.indexOf(withToken);
  if (withIndex < 0) return null;

  const newTextStart = withIndex + withToken.length;
  const inIndex = body.indexOf(inToken, newTextStart);
  if (inIndex < 0) return null;

  const oldText = body.slice(0, withIndex);
  const newText = body.slice(newTextStart, inIndex);
  const path = body.slice(inIndex + inToken.length);

  if (oldText === "" || newText === "" || path === "") return null;

  return { path, oldText, newText };
}

function parseCliWriteDemo(message: string): CliWriteRequest | null {
  const prefix = "create ";
  if (!message.startsWith(prefix)) return null;

  const path = message.slice(prefix.length);
  if (path === "") return null;

  return { path, content: '{"created":true}\n' };
}

function parseCliPatchDemo(message: string): CliPatchRequest | null {
  if (message !== "apply patch demo") return null;
  return {
    readPath: "src.ts",
    patch: [
      "*** Begin Patch",
      "*** Update File: src.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** Add File: docs/note.md",
      "+patched",
      "*** End Patch",
    ].join("\n"),
  };
}

function parseCliRemoveDemo(message: string): CliPatchRequest | null {
  const prefix = "remove ";
  if (!message.startsWith(prefix)) return null;

  const path = message.slice(prefix.length);
  if (path === "") return null;

  return {
    readPath: path,
    patch: [
      "*** Begin Patch",
      `*** Delete File: ${path}`,
      "*** End Patch",
    ].join("\n"),
  };
}

function parseCliMoveDemo(message: string): CliPatchRequest | null {
  const prefix = "move ";
  const toToken = " to ";
  if (!message.startsWith(prefix)) return null;

  const body = message.slice(prefix.length);
  const toIndex = body.indexOf(toToken);
  if (toIndex < 0) return null;

  const sourcePath = body.slice(0, toIndex);
  const targetPath = body.slice(toIndex + toToken.length);
  if (sourcePath === "" || targetPath === "") return null;

  return {
    readPath: sourcePath,
    patch: [
      "*** Begin Patch",
      `*** Update File: ${sourcePath}`,
      `*** Move to: ${targetPath}`,
      "*** End Patch",
    ].join("\n"),
  };
}

export function createCliFakeProvider(userMessage: string): LLMProvider {
  const patch =
    parseCliPatchDemo(userMessage) ??
    parseCliRemoveDemo(userMessage) ??
    parseCliMoveDemo(userMessage);
  if (patch !== null) {
    let turn = 0;
    return createObservedFakeProvider(async function* (options) {
      turn++;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "fake_read_before_patch",
          tool: "read",
          path: patch.readPath,
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }

      const toolContent = options.messages.findLast(
        (m) => m.role === "tool",
      )?.content;
      if (turn === 2) {
        if (toolContent?.startsWith("Tool failed:")) {
          yield { type: "text", text: toolContent };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "tool_call",
          id: "fake_apply_patch",
          tool: "apply_patch",
          patch: patch.patch,
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }

      const reply = toolContent?.startsWith("Tool failed:")
        ? toolContent
        : "Applied patch";
      yield { type: "text", text: reply };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
    });
  }

  const edit = parseCliEditDemo(userMessage);
  const write = parseCliWriteDemo(userMessage);
  if (edit === null) {
    if (write === null) {
      return createFakeProvider([fakeResponse("Hello from fake provider.")]);
    }

    let turn = 0;
    return createObservedFakeProvider(async function* (options) {
      turn++;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "fake_write",
          tool: "write",
          path: write.path,
          content: write.content,
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }

      const toolContent = options.messages.findLast(
        (m) => m.role === "tool",
      )?.content;
      const reply = toolContent?.startsWith("Tool failed:")
        ? toolContent
        : `Created ${write.path}`;
      yield { type: "text", text: reply };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
    });
  }

  let turn = 0;
  return createObservedFakeProvider(async function* (options) {
    turn++;
    if (turn === 1) {
      yield {
        type: "tool_call",
        id: "fake_read_before_edit",
        tool: "read",
        path: edit.path,
      };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      return;
    }

    const toolContent = options.messages.findLast(
      (m) => m.role === "tool",
    )?.content;
    if (turn === 2) {
      if (toolContent?.startsWith("Tool failed:")) {
        yield { type: "text", text: toolContent };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }
      yield {
        type: "tool_call",
        id: "fake_edit",
        tool: "edit",
        path: edit.path,
        edits: [{ oldText: edit.oldText, newText: edit.newText }],
      };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      return;
    }

    const reply = toolContent?.startsWith("Tool failed:")
      ? toolContent
      : `Edited ${edit.path}`;
    yield { type: "text", text: reply };
    yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
  });
}

export function createInteractiveFakeProvider(): LLMProvider {
  return createObservedFakeProvider(async function* (options) {
    const userMessages = options.messages.filter(
      (message) => message.role === "user",
    );
    const latest = userMessages.at(-1)?.content ?? "";
    const previous = userMessages.at(-2)?.content;
    const text =
      previous !== undefined && latest.endsWith("remember?")
        ? `Earlier you said: ${previous}`
        : `Remembered: ${latest}`;
    yield { type: "text", text };
    yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
  });
}
