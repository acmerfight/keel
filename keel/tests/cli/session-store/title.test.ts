import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  listSessionCatalog,
  persistSessionTitle,
  resumeSessionStore,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import {
  snapshotSessionRecordLine,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store - Title", () => {
  test(`Given a saved session title is longer than the display budget,
    When the title is persisted and the session is resumed,
    Then the store truncates the persisted title consistently`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-title-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const session = createSessionStore({
      sessionId: "titled",
      workspace,
      runtime: runtime(home),
    });
    const rawTitle = `Fix ${"login-timeout ".repeat(30)}`;

    try {
      // When
      const title = persistSessionTitle({
        session,
        title: rawTitle,
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "titled",
        workspace,
        runtime: runtime(home, 2),
      });
      const catalog = listSessionCatalog({
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(title.length).toBeLessThanOrEqual(200);
      expect(title.endsWith(" ")).toBe(false);
      expect(resumed.title).toBe(title);
      expect(catalog.sessions).toEqual([
        expect.objectContaining({
          id: "titled",
          workspace: ledgerWorkspace,
          title,
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a caller tries to persist a blank session title,
    When the title is normalized,
    Then the store rejects the empty title record`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-title-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const session = createSessionStore({
      sessionId: "blank-title",
      workspace,
      runtime: runtime(home),
    });

    try {
      // When
      let titleError: unknown;
      try {
        persistSessionTitle({
          session,
          title: "  \n\t  ",
          runtime: runtime(home, 1),
        });
      } catch (error) {
        titleError = error;
      }

      // Then
      expect(titleError).toBeInstanceOf(SessionStoreError);
      if (!(titleError instanceof Error)) {
        throw new Error("Expected blank title to throw an Error");
      }
      expect(titleError.message).toBe("Error: /title requires non-empty text.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session catalog reads a snapshot with a title,
    When sessions are listed,
    Then the catalog restores the title from the snapshot record`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-title-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await writeSessionLedger({
      home,
      id: "snapshotted-title",
      workspace: ledgerWorkspace,
      createdAt: "1970-01-01T00:00:00.000Z",
      records: [
        snapshotSessionRecordLine(
          "1970-01-01T00:00:01.000Z",
          [
            {
              role: "user",
              content: "remember release title",
              origin: { type: "user_prompt" },
            },
          ],
          "Release QA",
        ),
      ],
    });

    try {
      // When
      const catalog = listSessionCatalog({
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(catalog.sessions).toEqual([
        expect.objectContaining({
          id: "snapshotted-title",
          workspace: ledgerWorkspace,
          title: "Release QA",
          preview: "remember release title",
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
