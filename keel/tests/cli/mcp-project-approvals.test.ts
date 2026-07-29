import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  listMcpProjectApprovalGrants,
  type McpProjectApprovalGrant,
  saveMcpProjectApprovalGrant,
} from "../../src/cli/mcp-project-approvals.ts";

const MAX_APPROVAL_FILE_BYTES = 1024 * 1024;

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

describe("MCP project approvals", () => {
  test(`Given the current approval store is just below its byte limit,
    When one valid grant would make the next file exceed that limit,
    Then the save is rejected and the prior store remains readable`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-size-home-"));
    const projectRoot = "/project";
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
    };
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

  test(`Given concurrent processes save distinct exact MCP grants,
    When their read-modify-write operations overlap,
    Then the serialized store retains every grant once`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-race-home-"));
    const projectRoot = "/project";
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
    };
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
