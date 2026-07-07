import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  listBashProjectApprovalGrants,
  saveBashProjectApprovalGrant,
} from "../../src/cli/bash-project-approvals.ts";

describe("CLI - Bash Project Approval Store", () => {
  test(`Given the same project bash approval is saved from different cwd values,
    When Keel writes the approval store,
    Then the store keeps a single grant`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const workspace = await mkdtemp(join(tmpdir(), "keel-bash-project-"));
    const nestedWorkspace = join(workspace, "packages", "app");
    await mkdir(nestedWorkspace, { recursive: true });
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
    };
    const grant = {
      projectRoot: workspace,
      cwd: workspace,
      argvPrefix: ["git", "status"],
    };
    const nestedGrant = {
      projectRoot: workspace,
      cwd: nestedWorkspace,
      argvPrefix: ["git", "status"],
    };

    try {
      // When
      const firstSave = saveBashProjectApprovalGrant(runtime, grant);
      const secondSave = saveBashProjectApprovalGrant(runtime, nestedGrant);

      // Then
      expect(firstSave).toBe(true);
      expect(secondSave).toBe(false);
      expect(listBashProjectApprovalGrants(runtime, workspace)).toEqual([
        grant,
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
