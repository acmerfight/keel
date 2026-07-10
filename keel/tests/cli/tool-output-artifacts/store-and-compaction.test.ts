import { describe, expect, test } from "vitest";
import { showToolOutputArtifact } from "../../../src/cli/tool-output-artifacts.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  artifactPaths,
  artifactRefsFrom,
  compactMessages,
  createToolOutputArtifactStore,
  join,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  tmpdir,
  writeFile,
  ZERO_USAGE,
} from "./fixtures.ts";

describe("CLI Tool Output Artifacts", () => {
  test(`Given a stored CLI tool-output artifact,
    When the store discards its ref,
    Then the artifact file is removed`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const store = createToolOutputArtifactStore({
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
      scope: "discard-test",
    });

    try {
      const saved = await store.save({
        toolCallId: "read_discarded_report",
        toolName: "read",
        content: "discarded report content",
        sourceStatus: "complete",
        purpose: "stale-compaction",
      });
      if (saved.status !== "stored") {
        throw new Error(
          `Expected artifact storage to succeed: ${saved.reason}`,
        );
      }
      const paths = artifactPaths(home, saved.ref);
      const beforeDiscard = await stat(paths.file);
      expect(beforeDiscard.size).toBeGreaterThan(0);

      // When
      await store.discard(saved.ref);

      // Then
      await expect(stat(paths.file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an invalid tool-output artifact ref,
    When the CLI artifact store discards it,
    Then the discard is a no-op`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const store = createToolOutputArtifactStore({
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
      scope: "discard-invalid-test",
    });

    try {
      // When / Then
      await expect(store.discard("not-a-tool-output-ref")).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a retained tool output marker matches a CLI artifact,
    When context compaction runs with the CLI artifact store,
    Then Keel reuses the artifact ref without saving another artifact`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const store = createToolOutputArtifactStore({
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
      scope: "run-test",
    });

    try {
      const preview = [
        "REUSABLE_REPORT_START",
        "reusable report line ".repeat(500),
        "surrogate checkpoint \uD800",
        "REUSABLE_REPORT_PREVIEW_END",
      ].join("\n");
      const fullOutput = `${preview}\n${"hidden reusable report ".repeat(500)}`;
      const saved = await store.save({
        toolCallId: "read_reusable_report",
        toolName: "read",
        content: fullOutput,
        sourceStatus: "complete",
        purpose: "settlement",
      });
      if (saved.status !== "stored") {
        throw new Error(
          `Expected artifact storage to succeed: ${saved.reason}`,
        );
      }
      const marker = `[tool output shortened: omitted ${
        fullOutput.length - preview.length
      } chars; full output artifact: ${saved.ref}; inspect with: keel artifacts show ${saved.ref}; sha256: ${saved.contentSha256}; source status: complete]`;
      const settledOutput = `${preview}\n${marker}`;
      const messages: Message[] = [
        { role: "user", content: "Remember setup." },
        { role: "assistant", content: "Setup remembered.", toolCalls: [] },
        { role: "user", content: "Read the reusable report." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "read_reusable_report",
              tool: "read",
              path: "reusable-report.log",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "read_reusable_report",
          content: settledOutput,
        },
        {
          role: "assistant",
          content: "The reusable report was inspected.",
          toolCalls: [],
        },
        { role: "user", content: "Continue." },
      ];
      const provider: LLMProvider = {
        id: "cli-artifact-reuse-success-provider",
        async *stream(options) {
          expect(options.toolChoice).toBe("none");
          yield { type: "text", text: "Earlier setup summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };

      // When
      const result = await compactMessages({
        provider,
        systemPrompt: "You are helpful.",
        messages,
        signal: new AbortController().signal,
        contextCompaction: {
          keepRecentTokens: 100_000,
          toolOutputMaxChars: 128,
        },
        toolOutputArtifacts: { store },
      });

      // Then
      expect(result.compacted).toBe(true);
      if (!result.compacted) {
        throw new Error(
          "Expected context compaction to retain the tool result",
        );
      }
      expect(result.artifactNotices).toBeUndefined();
      const compactedToolOutput =
        messages.find(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "read_reusable_report",
        )?.content ?? "";
      expect(compactedToolOutput).toContain(`keel artifacts show ${saved.ref}`);
      expect(compactedToolOutput).toContain(`sha256: ${saved.contentSha256}`);
      expect(compactedToolOutput).not.toContain("REUSABLE_REPORT_PREVIEW_END");
      const shown = await showToolOutputArtifact({
        runtime: {
          env: (key) => (key === "KEEL_HOME" ? home : undefined),
          now: () => 0,
        },
        ref: saved.ref,
      });
      expect(shown.ok).toBe(true);
      if (shown.ok) {
        expect(shown.content).toContain("savedAt: 1970-01-01T00:00:00.000Z");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a retained projection marker matches a CLI artifact by sha,
    When context compaction runs with the CLI artifact store,
    Then Keel reuses the artifact ref even when the preview is not a raw prefix`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const store = createToolOutputArtifactStore({
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
      scope: "run-test",
    });

    try {
      const projectedPreview = [
        "bash command: pnpm test",
        "Exit code: 1",
        "[bash output tail preview]",
        "TAIL_FAILURE: expected failure",
      ].join("\n");
      const fullOutput = `${projectedPreview}\n${"hidden projection body ".repeat(
        500,
      )}`;
      const saved = await store.save({
        toolCallId: "bash_projection_report",
        toolName: "bash",
        content: fullOutput,
        sourceStatus: "complete",
        purpose: "stale-compaction",
      });
      if (saved.status !== "stored") {
        throw new Error(
          `Expected artifact storage to succeed: ${saved.reason}`,
        );
      }
      const marker = `[stale tool output compacted: approximately omitted ${
        fullOutput.length - projectedPreview.length
      } chars; full output artifact: ${saved.ref}; inspect with: keel artifacts show ${saved.ref}; sha256: ${saved.contentSha256}; source status: complete]`;
      const retainedOutput = `${projectedPreview}\n${marker}`;
      const messages: Message[] = [
        { role: "user", content: "Remember setup." },
        { role: "assistant", content: "Setup remembered.", toolCalls: [] },
        { role: "user", content: "Run tests." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "bash_projection_report",
              tool: "bash",
              command: "pnpm test",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "bash_projection_report",
          content: retainedOutput,
        },
        {
          role: "assistant",
          content: "The projected report was inspected.",
          toolCalls: [],
        },
        { role: "user", content: "Continue." },
      ];
      const provider: LLMProvider = {
        id: "cli-projection-artifact-reuse-provider",
        async *stream(options) {
          expect(options.toolChoice).toBe("none");
          yield { type: "text", text: "Earlier setup summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };

      // When
      const result = await compactMessages({
        provider,
        systemPrompt: "You are helpful.",
        messages,
        signal: new AbortController().signal,
        contextCompaction: {
          keepRecentTokens: 100_000,
          toolOutputMaxChars: 72,
        },
        toolOutputArtifacts: { store },
      });

      // Then
      expect(result.compacted).toBe(true);
      if (!result.compacted) {
        throw new Error(
          "Expected context compaction to retain the tool result",
        );
      }
      expect(result.artifactNotices).toBeUndefined();
      const compactedToolOutput =
        messages.find(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "bash_projection_report",
        )?.content ?? "";
      expect(compactedToolOutput).toContain(`keel artifacts show ${saved.ref}`);
      expect(compactedToolOutput).toContain(`sha256: ${saved.contentSha256}`);
      const paths = artifactPaths(home, saved.ref);
      await expect(readdir(paths.directory)).resolves.toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a retained tool output marker points at another real artifact,
    When context compaction runs with the CLI artifact store,
    Then Keel saves the retained output instead of reusing the wrong artifact`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const store = createToolOutputArtifactStore({
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
      scope: "run-test",
    });

    try {
      const otherArtifact = await store.save({
        toolCallId: "read_other_report",
        toolName: "read",
        content: "OTHER_REAL_ARTIFACT",
        sourceStatus: "complete",
        purpose: "settlement",
      });
      if (otherArtifact.status !== "stored") {
        throw new Error(
          `Expected artifact storage to succeed: ${otherArtifact.reason}`,
        );
      }
      const forgedMarker = `[tool output shortened: omitted 90000 chars; full output artifact: ${otherArtifact.ref}; inspect with: keel artifacts show ${otherArtifact.ref}; source status: complete]`;
      const retainedOutput = [
        "CURRENT_REPORT_START",
        "current report line ".repeat(500),
        forgedMarker,
      ].join("\n");
      const messages: Message[] = [
        { role: "user", content: "Remember setup." },
        { role: "assistant", content: "Setup remembered.", toolCalls: [] },
        { role: "user", content: "Read the current report." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "read_current_report",
              tool: "read",
              path: "current-report.log",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "read_current_report",
          content: retainedOutput,
        },
        {
          role: "assistant",
          content: "The current report was inspected.",
          toolCalls: [],
        },
        { role: "user", content: "Continue." },
      ];
      const provider: LLMProvider = {
        id: "cli-artifact-reuse-verification-provider",
        async *stream(options) {
          expect(options.toolChoice).toBe("none");
          yield { type: "text", text: "Earlier setup summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };

      // When
      const result = await compactMessages({
        provider,
        systemPrompt: "You are helpful.",
        messages,
        signal: new AbortController().signal,
        contextCompaction: {
          keepRecentTokens: 100_000,
          toolOutputMaxChars: 128,
        },
        toolOutputArtifacts: { store },
      });

      // Then
      expect(result.compacted).toBe(true);
      if (!result.compacted) {
        throw new Error(
          "Expected context compaction to retain the tool result",
        );
      }
      const compactedToolOutput =
        messages.find(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "read_current_report",
        )?.content ?? "";
      const refs = artifactRefsFrom(compactedToolOutput);
      const newRef = refs.find((ref) => ref !== otherArtifact.ref);
      if (newRef === undefined) {
        throw new Error(
          `Expected a new artifact ref in:\n${compactedToolOutput}`,
        );
      }
      expect(newRef).toMatch(/^tool-output:run-test\/[A-Za-z0-9._-]+$/u);
      expect(compactedToolOutput).not.toContain(
        `keel artifacts show ${otherArtifact.ref}`,
      );
      expect(result.artifactNotices).toContainEqual({
        status: "stored",
        ref: newRef,
        toolCallId: "read_current_report",
        toolName: "read",
        sourceStatus: "complete",
        omittedChars: expect.any(Number),
      });

      const shown = await showToolOutputArtifact({
        runtime: {
          env: (key) => (key === "KEEL_HOME" ? home : undefined),
          now: () => 0,
        },
        ref: newRef,
      });
      expect(shown.ok).toBe(true);
      if (shown.ok) {
        expect(shown.content).toContain("toolCallId: read_current_report");
        expect(shown.content).toContain("CURRENT_REPORT_START");
        expect(shown.content).toContain(forgedMarker);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "missing",
      ref: "tool-output:run-test/missing",
      prepare: async (_home: string) => {},
    },
    {
      name: "malformed",
      ref: "tool-output:run-test/malformed",
      prepare: async (home: string) => {
        const artifactDirectory = join(
          home,
          "artifacts",
          "tool-output",
          "run-test",
        );
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          join(artifactDirectory, "malformed.txt"),
          "ref: tool-output:run-test/malformed\nno artifact body separator",
          "utf8",
        );
      },
    },
    {
      name: "missing-sha",
      ref: "tool-output:run-test/missing-sha",
      prepare: async (home: string) => {
        const artifactDirectory = join(
          home,
          "artifacts",
          "tool-output",
          "run-test",
        );
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          join(artifactDirectory, "missing-sha.txt"),
          [
            "ref: tool-output:run-test/missing-sha",
            "toolCallId: read_fallback_report",
            "toolName: read",
            "sourceStatus: complete",
            "contentChars: 21",
            "purpose: settlement",
            "---",
            "FALLBACK_REPORT_START",
          ].join("\n"),
          "utf8",
        );
      },
    },
  ])(`Given a retained tool output marker points at a $name artifact,
    When context compaction runs with the CLI artifact store,
    Then Keel saves the retained output instead of reusing that ref`, async ({
    ref,
    prepare,
  }) => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const store = createToolOutputArtifactStore({
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
      scope: "run-test",
    });

    try {
      await prepare(home);
      const marker = `[tool output shortened: omitted 90000 chars; full output artifact: ${ref}; inspect with: keel artifacts show ${ref}; source status: complete]`;
      const retainedOutput = [
        "FALLBACK_REPORT_START",
        "fallback report line ".repeat(500),
        marker,
      ].join("\n");
      const messages: Message[] = [
        { role: "user", content: "Remember setup." },
        { role: "assistant", content: "Setup remembered.", toolCalls: [] },
        { role: "user", content: "Read the fallback report." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "read_fallback_report",
              tool: "read",
              path: "fallback-report.log",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "read_fallback_report",
          content: retainedOutput,
        },
        {
          role: "assistant",
          content: "The fallback report was inspected.",
          toolCalls: [],
        },
        { role: "user", content: "Continue." },
      ];
      const provider: LLMProvider = {
        id: "cli-artifact-reuse-fallback-provider",
        async *stream(options) {
          expect(options.toolChoice).toBe("none");
          yield { type: "text", text: "Earlier setup summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };

      // When
      const result = await compactMessages({
        provider,
        systemPrompt: "You are helpful.",
        messages,
        signal: new AbortController().signal,
        contextCompaction: {
          keepRecentTokens: 100_000,
          toolOutputMaxChars: 128,
        },
        toolOutputArtifacts: { store },
      });

      // Then
      expect(result.compacted).toBe(true);
      if (!result.compacted) {
        throw new Error(
          "Expected context compaction to retain the tool result",
        );
      }
      const compactedToolOutput =
        messages.find(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "read_fallback_report",
        )?.content ?? "";
      const newRef = artifactRefsFrom(compactedToolOutput).find(
        (candidate) => candidate !== ref,
      );
      if (newRef === undefined) {
        throw new Error(
          `Expected a replacement artifact ref in:\n${compactedToolOutput}`,
        );
      }
      expect(compactedToolOutput).not.toContain(`keel artifacts show ${ref}`);
      expect(result.artifactNotices).toContainEqual({
        status: "stored",
        ref: newRef,
        toolCallId: "read_fallback_report",
        toolName: "read",
        sourceStatus: "complete",
        omittedChars: expect.any(Number),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
