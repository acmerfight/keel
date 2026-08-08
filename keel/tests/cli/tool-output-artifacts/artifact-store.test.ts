import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  cleanupExpiredToolOutputArtifacts,
  createToolOutputArtifactStore,
  showToolOutputArtifact,
} from "../../../src/cli/tool-output-artifacts.ts";

function artifactRuntime(home: string, now = 0) {
  return {
    env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
    now: () => now,
  };
}

describe("CLI tool-output artifact store", () => {
  test(`Given transcript persistence is cancelled before publication,
    When the abortable artifact store settles,
    Then it leaves neither a final artifact nor a temporary partial file`, async () => {
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-abort-"));
    const scope = "cancelled-publication";
    const store = createToolOutputArtifactStore({
      runtime: artifactRuntime(home),
      scope,
    });
    const controller = new AbortController();

    try {
      const saving = store.save({
        toolCallId: "cancelled_transcript",
        toolName: "submit_agent_result",
        content: "partial transcript must never become visible",
        sourceStatus: "complete",
        purpose: "settlement",
        signal: controller.signal,
      });
      controller.abort(new Error("cancel persistence"));
      const saved = await saving;

      expect(saved.status).toBe("failed");
      expect(
        await readdir(join(home, "artifacts", "tool-output", scope)).catch(
          () => [],
        ),
      ).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given raw tool output is saved in a managed scope,
    When the artifact store returns and opens its ref,
    Then metadata, unredacted content, and private filesystem modes are preserved`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-store-"));
    const runtime = artifactRuntime(home, Date.UTC(2026, 0, 1));
    const store = createToolOutputArtifactStore({
      runtime,
      scope: "store-contract",
    });
    const rawSecret = "API_KEY=sk-artifact-store-secret";

    try {
      // When
      const saved = await store.save({
        toolCallId: "read_store_contract",
        toolName: "read",
        content: `STORE_START\n${rawSecret}\nSTORE_END`,
        sourceStatus: "complete",
        purpose: "settlement",
      });

      // Then
      expect(saved.status).toBe("stored");
      if (saved.status !== "stored") {
        throw new Error(
          `Expected artifact storage to succeed: ${saved.reason}`,
        );
      }
      const shown = await showToolOutputArtifact({ runtime, ref: saved.ref });
      expect(shown.ok).toBe(true);
      if (!shown.ok) {
        throw new Error(shown.message);
      }
      expect(shown.content).toContain(`ref: ${saved.ref}`);
      expect(shown.content).toContain("tool: read");
      expect(shown.content).toContain("toolCallId: read_store_contract");
      expect(shown.content).toContain("sourceStatus: complete");
      expect(shown.content).toContain("purpose: settlement");
      expect(shown.content).toContain("savedAt: 2026-01-01T00:00:00.000Z");
      expect(shown.content).toContain(
        "atRestPolicy: raw unredacted tool output",
      );
      expect(shown.content).toContain(rawSecret);
      expect(shown.content).not.toContain("[REDACTED_SECRET]");

      const [, scope = "", id = ""] =
        /^tool-output:([^/]+)\/([^/]+)$/u.exec(saved.ref) ?? [];
      const directory = join(home, "artifacts", "tool-output", scope);
      const file = join(directory, `${id}.txt`);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME is a file instead of a directory,
    When the artifact store saves tool output,
    Then it returns a storage failure without throwing`, async () => {
    // Given
    const parent = await mkdtemp(join(tmpdir(), "keel-artifact-store-"));
    const blockedHome = join(parent, "blocked-home");
    await writeFile(blockedHome, "not a directory", "utf8");
    const store = createToolOutputArtifactStore({
      runtime: artifactRuntime(blockedHome),
      scope: "store-failure",
    });

    try {
      // When
      const saved = await store.save({
        toolCallId: "read_failed_store",
        toolName: "read",
        content: "output that cannot be stored",
        sourceStatus: "complete",
        purpose: "settlement",
      });

      // Then
      expect(saved.status).toBe("failed");
      if (saved.status === "failed") {
        expect(saved.reason).toContain("not a directory");
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME is a file instead of a directory,
    When artifact retention cleanup inspects the store,
    Then cleanup treats the inaccessible artifact root as recoverable`, async () => {
    // Given
    const parent = await mkdtemp(join(tmpdir(), "keel-artifact-cleanup-"));
    const blockedHome = join(parent, "blocked-home");
    await writeFile(blockedHome, "not a directory", "utf8");

    try {
      // When / Then
      await expect(
        cleanupExpiredToolOutputArtifacts({
          runtime: artifactRuntime(blockedHome),
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test(`Given expired, recent, and unmanaged artifact entries,
    When artifact retention cleanup runs,
    Then only expired managed artifact files are removed`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-cleanup-"));
    const now = Date.UTC(2026, 0, 31);
    const root = join(home, "artifacts", "tool-output");
    const scope = join(root, "session-cleanup");
    const emptyScope = join(root, "empty-scope");
    await mkdir(scope, { recursive: true });
    await mkdir(emptyScope);
    await writeFile(join(root, "not-a-scope-file"), "ignored", "utf8");
    await mkdir(join(root, "bad..scope"));
    const expired = join(scope, "expired.txt");
    const recent = join(scope, "recent.txt");
    const expiredTemp = join(
      scope,
      "11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.tmp",
    );
    const recentTemp = join(
      scope,
      "33333333-3333-4333-8333-333333333333.44444444-4444-4444-8444-444444444444.tmp",
    );
    await writeFile(expired, "expired artifact", "utf8");
    await writeFile(recent, "recent artifact", "utf8");
    await writeFile(expiredTemp, "interrupted raw transcript", "utf8");
    await writeFile(recentTemp, "recent interrupted write", "utf8");
    await writeFile(join(scope, "ignored.md"), "ignored extension", "utf8");
    await writeFile(join(scope, "bad..id.txt"), "invalid id", "utf8");
    await mkdir(join(scope, "nested.txt"));
    const dayMs = 24 * 60 * 60 * 1000;
    await utimes(
      expired,
      new Date(now - 31 * dayMs),
      new Date(now - 31 * dayMs),
    );
    await utimes(recent, new Date(now - dayMs), new Date(now - dayMs));
    await utimes(
      expiredTemp,
      new Date(now - 31 * dayMs),
      new Date(now - 31 * dayMs),
    );
    await utimes(recentTemp, new Date(now - dayMs), new Date(now - dayMs));

    try {
      // When
      await cleanupExpiredToolOutputArtifacts({
        runtime: artifactRuntime(home, now),
      });

      // Then
      expect((await readdir(scope)).sort()).toEqual([
        "33333333-3333-4333-8333-333333333333.44444444-4444-4444-8444-444444444444.tmp",
        "bad..id.txt",
        "ignored.md",
        "nested.txt",
        "recent.txt",
      ]);
      await expect(stat(emptyScope)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given artifact refs are malformed, unsafe, or missing,
    When the artifact store opens or verifies them,
    Then it rejects the ref or reports the managed file as missing`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-show-"));
    const runtime = artifactRuntime(home);
    const store = createToolOutputArtifactStore({
      runtime,
      scope: "ref-validation",
    });

    try {
      // When
      const malformed = await showToolOutputArtifact({
        runtime,
        ref: "../secret",
      });
      const traversal = await showToolOutputArtifact({
        runtime,
        ref: "tool-output:a..b/id",
      });
      const missing = await showToolOutputArtifact({
        runtime,
        ref: "tool-output:run/id",
      });
      const malformedReuse = await store.verifyReusable({
        ref: "../secret",
        toolCallId: "read_secret",
        previewContent: "secret",
        omittedChars: 1,
        previewKind: "prefix",
        sourceStatus: "complete",
      });

      // Then
      expect(malformed).toEqual({
        ok: false,
        message:
          'Error: invalid artifact ref "../secret". Use tool-output:<scope>/<id>.',
      });
      expect(traversal).toEqual({
        ok: false,
        message:
          'Error: invalid artifact ref "tool-output:a..b/id". Use tool-output:<scope>/<id>.',
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.message).toContain(
          "Error: cannot read artifact tool-output:run/id:",
        );
      }
      expect(malformedReuse).toEqual({ status: "not_reusable" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
