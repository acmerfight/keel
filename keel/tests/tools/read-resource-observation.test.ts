import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";
import { revalidateReadResource } from "../../src/tools/read-resource-observation.ts";

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function observedRead(
  workspace: string,
  path: string,
  options: { readonly offset?: number; readonly limit?: number } = {},
) {
  const toolCall = {
    id: "read_1",
    tool: "read",
    path,
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  } as const;
  const execution = await executeToolCall({
    workspace,
    toolCall,
    signal: freshSignal(),
    allowBash: false,
  });
  if (execution.resourceObservation === undefined) {
    throw new Error("expected read resource observation");
  }
  return { toolCall, observation: execution.resourceObservation };
}

describe("Read Resource Observation", () => {
  test(`Given a recorded read projection changes,
    When Runtime revalidates the same requested path and window,
    Then it reports the evidence as changed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-freshness-"));
    const path = join(workspace, "state.txt");
    try {
      await writeFile(path, "status=READY\n");
      const read = await observedRead(workspace, "state.txt");
      await writeFile(path, "status=BROKEN\n");

      // When
      const freshness = revalidateReadResource({ workspace, ...read });

      // Then
      expect(freshness).toEqual({
        status: "changed",
        reason:
          "The current file projection no longer matches the recorded read evidence.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given content outside a bounded read projection changes,
    When Runtime revalidates the same window,
    Then the observed evidence still matches`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-freshness-"));
    const path = join(workspace, "state.txt");
    try {
      await writeFile(path, "status=READY\nnotes=old\n");
      const read = await observedRead(workspace, "state.txt", { limit: 1 });
      await writeFile(path, "status=READY\nnotes=new\n");

      // When
      const freshness = revalidateReadResource({ workspace, ...read });

      // Then
      expect(freshness.status).toBe("matches");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an observed file is removed,
    When Runtime revalidates its read evidence,
    Then it reports the resource as missing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-freshness-"));
    const path = join(workspace, "state.txt");
    try {
      await writeFile(path, "status=READY\n");
      const read = await observedRead(workspace, "state.txt");
      await unlink(path);

      // When
      const freshness = revalidateReadResource({ workspace, ...read });

      // Then
      expect(freshness.status).toBe("missing");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a requested symlink is replaced with another same-content target,
    When Runtime revalidates the read evidence,
    Then it reports the resolved resource as changed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-freshness-"));
    const first = join(workspace, "first.txt");
    const second = join(workspace, "second.txt");
    const link = join(workspace, "current.txt");
    try {
      await writeFile(first, "status=READY\n");
      await writeFile(second, "status=READY\n");
      await symlink(first, link);
      const read = await observedRead(workspace, "current.txt");
      await unlink(link);
      await symlink(second, link);

      // When
      const freshness = revalidateReadResource({ workspace, ...read });

      // Then
      expect(freshness.status).toBe("changed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an observed path becomes ignored by project policy,
    When Runtime cannot safely reread it,
    Then it reports the evidence as unverifiable`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-freshness-"));
    try {
      await writeFile(join(workspace, "state.txt"), "status=READY\n");
      const read = await observedRead(workspace, "state.txt");
      await writeFile(join(workspace, ".gitignore"), "state.txt\n");

      // When
      const freshness = revalidateReadResource({ workspace, ...read });

      // Then
      expect(freshness.status).toBe("unverifiable");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a recorded line window disappears after the file shrinks,
    When Runtime revalidates the same offset,
    Then it reports the projection as changed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-freshness-"));
    const path = join(workspace, "state.txt");
    try {
      await writeFile(path, "first\nsecond\n");
      const read = await observedRead(workspace, "state.txt", { offset: 2 });
      await writeFile(path, "first\n");

      // When
      const freshness = revalidateReadResource({ workspace, ...read });

      // Then
      expect(freshness).toEqual({
        status: "changed",
        reason: "The observed read projection no longer exists in the file.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the workspace disappears after a read,
    When Runtime encounters an unexpected filesystem error during revalidation,
    Then it fails closed as unverifiable`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-freshness-"));
    await writeFile(join(workspace, "state.txt"), "status=READY\n");
    const read = await observedRead(workspace, "state.txt");
    await rm(workspace, { recursive: true, force: true });

    // When
    const freshness = revalidateReadResource({ workspace, ...read });

    // Then
    expect(freshness.status).toBe("unverifiable");
  });
});
