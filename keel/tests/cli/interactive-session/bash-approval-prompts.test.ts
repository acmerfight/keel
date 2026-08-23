import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createPromptedBashPermissionPolicy } from "../../../src/cli/interactive-session/bash-approval.ts";
import { createLineReader } from "../../../src/cli/interactive-session/line-reader.ts";

describe("Interactive Session - Bash Approval Prompts", () => {
  test(`Given a reviewed Bash request in a real TTY,
    When the user allows the exact command once,
    Then the prompt binds the decision to its command and cwd`, async () => {
    // Given
    const input = new PassThrough();
    const promptInput = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const lineReader = createLineReader(promptInput, {});
    const promptLifecycle: string[] = [];
    let stderr = "";
    const policy = createPromptedBashPermissionPolicy(
      lineReader,
      (text) => {
        stderr += text;
        input.end("y\n");
      },
      {
        onPromptStart: () => promptLifecycle.push("approval"),
        onPromptEnd: () => promptLifecycle.push("steer"),
      },
    );

    try {
      // When
      const decision = await policy.review({
        command: "pnpm test",
        cwd: "/workspace/project",
        signal: new AbortController().signal,
      });

      // Then
      expect(decision).toEqual({ type: "allow" });
      expect(stderr).toContain("cwd: /workspace/project");
      expect(stderr).toContain("$ pnpm test");
      expect(stderr).toContain(
        "[y] allow once, [n] deny; any other input denies: ",
      );
      expect(stderr).not.toContain("command family");
      expect(stderr).not.toContain("for this run");
      expect(promptLifecycle).toEqual(["approval", "steer"]);
    } finally {
      promptInput.close();
    }
  });

  test(`Given a reviewed Bash request,
    When the user enters anything except an affirmative answer,
    Then Runtime denies the command without creating reusable authority`, async () => {
    // Given
    const input = new PassThrough();
    const promptInput = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const lineReader = createLineReader(promptInput, {});
    const policy = createPromptedBashPermissionPolicy(lineReader, () => {
      input.end("session\n");
    });

    try {
      // When
      const decision = await policy.review({
        command: "git status --short",
        cwd: "/workspace/project",
        signal: new AbortController().signal,
      });

      // Then
      expect(decision).toEqual({
        type: "deny",
        message: "User did not approve this command.",
      });
    } finally {
      promptInput.close();
    }
  });

  test(`Given approval input closes while a reviewed Bash request is pending,
    When Runtime cannot read a response,
    Then it fails closed with an interruption reason`, async () => {
    // Given
    const input = new PassThrough();
    const promptInput = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const lineReader = createLineReader(promptInput, {});
    const policy = createPromptedBashPermissionPolicy(lineReader, () => {
      input.end();
    });

    try {
      // When
      const decision = await policy.review({
        command: "pnpm test",
        cwd: "/workspace/project",
        signal: new AbortController().signal,
      });

      // Then
      expect(decision).toEqual({
        type: "deny",
        message: "Command approval was interrupted or input closed.",
      });
    } finally {
      promptInput.close();
    }
  });

  test(`Given a reviewed Bash request is cancelled while awaiting input,
    When the active request signal aborts,
    Then Runtime denies without consuming a later conversation line`, async () => {
    // Given
    const input = new PassThrough();
    const promptInput = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const lineReader = createLineReader(promptInput, {});
    const controller = new AbortController();
    const policy = createPromptedBashPermissionPolicy(lineReader, () => {
      controller.abort();
    });

    try {
      // When
      const decision = await policy.review({
        command: "pnpm test",
        cwd: "/workspace/project",
        signal: controller.signal,
      });
      input.write("continue the conversation\n");

      // Then
      expect(decision).toEqual({
        type: "deny",
        message: "Command approval was interrupted or input closed.",
      });
      await expect(lineReader.readLine()).resolves.toMatchObject({
        line: "continue the conversation",
      });
    } finally {
      input.end();
      promptInput.close();
    }
  });
});
