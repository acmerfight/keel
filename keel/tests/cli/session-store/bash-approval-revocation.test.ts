import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionBashApprovalRevoked,
  persistSessionBashApprovalsCleared,
  persistSessionQueuedInput,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import type { BashApprovalGrant } from "../../../src/permissions/bash.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store - Bash Approval Revocation", () => {
  test(`Given bash approval grants are revoked or cleared in the session ledger,
    When the session is resumed,
    Then only non-revoked active approvals are restored`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const exactGrant = {
      type: "exact",
      cwd: ledgerWorkspace,
      command: "pnpm test",
    } satisfies BashApprovalGrant;
    const prefixGrant = {
      type: "prefix",
      cwd: ledgerWorkspace,
      argvPrefix: ["git", "status"],
    } satisfies BashApprovalGrant;
    const commandFamilyGrant = {
      type: "command_family",
      cwd: ledgerWorkspace,
      commandFamily: "pnpm_vitest_run_workspace_test_selectors",
    } satisfies BashApprovalGrant;

    try {
      const session = createSessionStore({
        sessionId: "bash-approval-revoke",
        workspace,
        runtime: runtime(home),
      });
      persistSessionBashApprovalGrant({
        session,
        grant: exactGrant,
        runtime: runtime(home, 1),
      });
      persistSessionBashApprovalGrant({
        session,
        grant: exactGrant,
        runtime: runtime(home, 2),
      });
      persistSessionBashApprovalGrant({
        session,
        grant: prefixGrant,
        runtime: runtime(home, 3),
      });
      persistSessionBashApprovalGrant({
        session,
        grant: commandFamilyGrant,
        runtime: runtime(home, 4),
      });
      persistSessionBashApprovalRevoked({
        session,
        grant: exactGrant,
        runtime: runtime(home, 5),
      });

      // When
      const resumedAfterRevoke = resumeSessionStore({
        sessionId: "bash-approval-revoke",
        workspace,
        runtime: runtime(home, 6),
      });

      // Then
      expect(resumedAfterRevoke.bashApprovalGrants).toEqual([
        prefixGrant,
        commandFamilyGrant,
      ]);

      // When
      const clearInput = persistSessionQueuedInput({
        session,
        sequence: 7,
        line: "/approvals clear",
        runtime: runtime(home, 7),
      });
      persistSessionBashApprovalsCleared({
        session,
        runtime: runtime(home, 8),
        consumedInputIds: [clearInput.id],
      });
      const resumedAfterClear = resumeSessionStore({
        sessionId: "bash-approval-revoke",
        workspace,
        runtime: runtime(home, 9),
      });

      // Then
      expect(resumedAfterClear.bashApprovalGrants).toEqual([]);
      expect(resumedAfterClear.pendingInputs).toEqual([]);
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger).toContain(`"consumedInputIds":["${clearInput.id}"]`);

      // When
      persistSessionBashApprovalGrant({
        session,
        grant: prefixGrant,
        runtime: runtime(home, 10),
      });
      persistSessionBashApprovalsCleared({
        session,
        runtime: runtime(home, 11),
      });
      const resumedAfterDirectClear = resumeSessionStore({
        sessionId: "bash-approval-revoke",
        workspace,
        runtime: runtime(home, 12),
      });

      // Then
      expect(resumedAfterDirectClear.bashApprovalGrants).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a bash approval revocation contains a secret-like command,
    When the ledger is written and resumed,
    Then the revocation audit record is redacted and not restored as an active approval`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const grant = {
      type: "exact",
      cwd: ledgerWorkspace,
      command: "printf 'Bearer live-secret-approval-token'",
    } satisfies BashApprovalGrant;

    try {
      const session = createSessionStore({
        sessionId: "bash-approval-redacted-revoke",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionBashApprovalRevoked({
        session,
        grant,
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "bash-approval-redacted-revoke",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger).not.toContain("live-secret-approval-token");
      expect(ledger).toContain("printf 'Bearer [REDACTED_SECRET]'");
      expect(resumed.bashApprovalGrants).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
