import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  clearMcpProjectApprovalGrants,
  formatMcpProjectApprovalClearResult,
  formatMcpProjectApprovalList,
  listMcpProjectApprovalGrants,
  type McpProjectApprovalGrant,
  revokeMcpProjectApprovalGrant,
  saveMcpProjectApprovalGrant,
} from "../../src/cli/mcp-project-approvals.ts";

const MAX_APPROVAL_FILE_BYTES = 1024 * 1024;
const MAX_APPROVAL_GRANTS = 1_024;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function oauthGrant(
  projectRoot: string,
  index: number,
): McpProjectApprovalGrant {
  return {
    projectRoot,
    serverId: "catalog",
    origin: "https://catalog.example",
    configurationDigest: digest("configuration"),
    rawToolName: "search",
    descriptorDigest: digest("descriptor"),
    authorizationIdentity: {
      kind: "oauth",
      issuer: "https://auth.example",
      clientId: "c".repeat(4_096),
      grantId: "00000000-0000-4000-8000-000000000001",
    },
    argumentsDigest: digest(`arguments-${index}`),
  };
}

function anonymousGrant(
  projectRoot: string,
  index: number,
): McpProjectApprovalGrant {
  return {
    projectRoot,
    serverId: "catalog",
    origin: "https://catalog.example",
    configurationDigest: digest("configuration"),
    rawToolName: "search",
    descriptorDigest: digest("descriptor"),
    authorizationIdentity: { kind: "anonymous" },
    argumentsDigest: digest(`arguments-${index}`),
  };
}

function approvalRuntime(home: string) {
  return {
    env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
  };
}

describe("MCP project approvals", () => {
  test(`Given the current approval store is just below its byte limit,
    When one valid grant would make the next file exceed that limit,
    Then the save is rejected and the prior store remains readable`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-size-home-"));
    const projectRoot = "/project";
    const runtime = approvalRuntime(home);
    const grants: McpProjectApprovalGrant[] = [];
    for (let index = 0; ; index += 1) {
      const candidate = oauthGrant(projectRoot, index);
      const serialized = `${JSON.stringify(
        { schemaVersion: 1, grants: [...grants, candidate] },
        null,
        2,
      )}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_APPROVAL_FILE_BYTES) {
        break;
      }
      grants.push(candidate);
    }
    await mkdir(home, { recursive: true });
    const filePath = join(home, "mcp-project-approvals.json");
    await writeFile(
      filePath,
      `${JSON.stringify({ schemaVersion: 1, grants }, null, 2)}\n`,
      "utf8",
    );

    try {
      expect(grants.length).toBeGreaterThan(1);
      expect(
        Buffer.byteLength(await readFile(filePath, "utf8"), "utf8"),
      ).toBeLessThanOrEqual(MAX_APPROVAL_FILE_BYTES);

      // When / Then
      await expect(
        saveMcpProjectApprovalGrant(
          runtime,
          oauthGrant(projectRoot, grants.length),
        ),
      ).rejects.toThrow("file would exceed 1048576 bytes");
      await expect(
        listMcpProjectApprovalGrants(runtime, projectRoot),
      ).resolves.toHaveLength(grants.length);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an approval store is oversized, unreadable, malformed JSON, or invalid schema,
    When the current project's grants are loaded,
    Then each corrupted state fails closed with a bounded diagnostic`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-mcp-approval-invalid-home-"),
    );
    const runtime = approvalRuntime(home);
    const filePath = join(home, "mcp-project-approvals.json");

    try {
      // When / Then
      await writeFile(
        filePath,
        "x".repeat(MAX_APPROVAL_FILE_BYTES + 1),
        "utf8",
      );
      await expect(
        listMcpProjectApprovalGrants(runtime, "/project"),
      ).rejects.toThrow("file exceeds 1048576 bytes");

      await writeFile(filePath, "{", "utf8");
      await expect(
        listMcpProjectApprovalGrants(runtime, "/project"),
      ).rejects.toThrow("invalid JSON");

      await writeFile(
        filePath,
        JSON.stringify({ schemaVersion: 1, grants: [{ invalid: true }] }),
        "utf8",
      );
      await expect(
        listMcpProjectApprovalGrants(runtime, "/project"),
      ).rejects.toThrow("cannot read MCP project approvals");

      await rm(filePath);
      await mkdir(filePath);
      await expect(
        listMcpProjectApprovalGrants(runtime, "/project"),
      ).rejects.toThrow("cannot read MCP project approvals");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the approval store already contains its maximum number of compact grants,
    When another distinct grant is saved,
    Then the explicit grant-count bound rejects the write`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-count-home-"));
    const runtime = approvalRuntime(home);
    const projectRoot = "/project";
    const grants = Array.from({ length: MAX_APPROVAL_GRANTS }, (_, index) =>
      anonymousGrant(projectRoot, index),
    );
    await writeFile(
      join(home, "mcp-project-approvals.json"),
      `${JSON.stringify({ schemaVersion: 1, grants }, null, 2)}\n`,
      "utf8",
    );

    try {
      // When / Then
      await expect(
        saveMcpProjectApprovalGrant(
          runtime,
          anonymousGrant(projectRoot, MAX_APPROVAL_GRANTS),
        ),
      ).rejects.toThrow("support at most 1024 grants");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one exact grant is already saved,
    When it is saved again, an absent index is revoked, and an empty project is cleared,
    Then duplicate and no-op mutations are explicit and preserve the store`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-noop-home-"));
    const runtime = approvalRuntime(home);
    const projectRoot = "/project";
    const grant = oauthGrant(projectRoot, 0);

    try {
      await expect(saveMcpProjectApprovalGrant(runtime, grant)).resolves.toBe(
        true,
      );

      // When / Then
      await expect(saveMcpProjectApprovalGrant(runtime, grant)).resolves.toBe(
        false,
      );
      await expect(
        revokeMcpProjectApprovalGrant(runtime, projectRoot, 2),
      ).resolves.toBeNull();
      await expect(
        clearMcpProjectApprovalGrants(runtime, "/other-project"),
      ).resolves.toBe(0);
      await expect(
        listMcpProjectApprovalGrants(runtime, projectRoot),
      ).resolves.toHaveLength(1);
      expect(formatMcpProjectApprovalList([grant])).toContain(
        "authorization issuer: https://auth.example",
      );
      expect(formatMcpProjectApprovalClearResult(0)).toBe(
        "No MCP project approvals to clear.\n",
      );
      expect(formatMcpProjectApprovalClearResult(1)).toBe(
        "Cleared 1 MCP project approval.\n",
      );
      expect(formatMcpProjectApprovalClearResult(2)).toBe(
        "Cleared 2 MCP project approvals.\n",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a stale approval lock is left by a dead writer,
    When the store is read,
    Then the stale lock is reclaimed before the operation proceeds`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-stale-home-"));
    const runtime = approvalRuntime(home);
    const lockPath = join(home, ".mcp-project-approvals.lock");
    await writeFile(lockPath, "", "utf8");
    const stale = new Date(Date.now() - 31_000);
    await utimes(lockPath, stale, stale);

    try {
      // When / Then
      await expect(
        listMcpProjectApprovalGrants(runtime, "/project"),
      ).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a live approval lock does not become available,
    When lock acquisition reaches its deadline,
    Then the operation fails with an explicit busy error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-busy-home-"));
    const runtime = approvalRuntime(home);
    await writeFile(join(home, ".mcp-project-approvals.lock"), "", "utf8");

    try {
      // When / Then
      await expect(
        listMcpProjectApprovalGrants(runtime, "/project"),
      ).rejects.toThrow("MCP project approvals are busy");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 10_000);

  test(`Given concurrent processes save distinct exact MCP grants,
    When their read-modify-write operations overlap,
    Then the serialized store retains every grant once`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-race-home-"));
    const projectRoot = "/project";
    const runtime = approvalRuntime(home);
    const grants = Array.from({ length: 12 }, (_, index) => ({
      ...oauthGrant(projectRoot, index),
      authorizationIdentity: { kind: "anonymous" } as const,
    }));

    try {
      // When
      await Promise.all(
        grants.map(
          async (grant) => await saveMcpProjectApprovalGrant(runtime, grant),
        ),
      );

      // Then
      await expect(
        listMcpProjectApprovalGrants(runtime, projectRoot),
      ).resolves.toHaveLength(grants.length);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
