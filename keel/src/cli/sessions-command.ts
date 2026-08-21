import { listUndoCheckpoints } from "../core/git.ts";
import type { CliArgs } from "./args.ts";
import type { CliRuntime } from "./runtime.ts";
import {
  formatArchivedSessionCatalog,
  formatSessionArchived,
  formatSessionCatalog,
  formatSessionCatalogWarnings,
  formatSessionDetail,
  formatSessionForkCreated,
  formatSessionRepairResult,
  formatSessionUnarchived,
} from "./session-catalog-format.ts";
import {
  acquireSessionLock,
  archiveSessionStore,
  ensureSessionCanBeCreated,
  forkSessionStore,
  listArchivedSessionCatalog,
  listSessionCatalog,
  readSessionCatalogEntry,
  repairSessionStore,
  resumeSessionStore,
  type SessionLock,
  SessionStoreError,
  unarchiveSessionStore,
} from "./session-store.ts";

type SessionsCliArgs = Extract<CliArgs, { readonly command: "sessions" }>;

export function runSessionsCommand(
  cliArgs: SessionsCliArgs,
  runtime: CliRuntime,
): number {
  if (cliArgs.mode === "archive" || cliArgs.mode === "unarchive") {
    try {
      if (cliArgs.mode === "archive") {
        archiveSessionStore({
          sessionId: cliArgs.sessionId,
          workspace: runtime.cwd(),
          runtime,
        });
        runtime.writeStdout(formatSessionArchived(cliArgs.sessionId));
      } else {
        unarchiveSessionStore({
          sessionId: cliArgs.sessionId,
          workspace: runtime.cwd(),
          runtime,
        });
        runtime.writeStdout(formatSessionUnarchived(cliArgs.sessionId));
      }
      return 0;
    } catch (error) {
      /* v8 ignore next 3 -- unexpected faults are handled by the outer CLI runtime boundary. */
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
  }

  if (cliArgs.mode === "repair") {
    let sessionLock: SessionLock | undefined;
    try {
      sessionLock = acquireSessionLock({
        sessionId: cliArgs.sessionId,
        runtime,
      });
      const result = repairSessionStore({
        sessionId: cliArgs.sessionId,
        workspace: runtime.cwd(),
        runtime,
        strategy: cliArgs.strategy,
      });
      runtime.writeStdout(
        formatSessionRepairResult({
          sessionId: cliArgs.sessionId,
          result,
        }),
      );
      return 0;
    } catch (error) {
      /* v8 ignore next 3 -- unexpected faults are handled by the outer CLI runtime boundary. */
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    } finally {
      sessionLock?.release();
    }
  }

  if (cliArgs.mode === "show") {
    try {
      const entry = readSessionCatalogEntry({
        sessionId: cliArgs.sessionId,
        workspace: runtime.cwd(),
        runtime,
      });
      const session = resumeSessionStore({
        sessionId: cliArgs.sessionId,
        workspace: runtime.cwd(),
        runtime,
      });
      runtime.writeStdout(
        formatSessionDetail({
          entry,
          session,
          timelineLimit: cliArgs.timelineLimit,
          undoCheckpoints: listUndoCheckpoints(entry.workspace),
        }),
      );
      return 0;
    } catch (error) {
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
  }

  if (cliArgs.mode === "fork") {
    let sourceSessionLock: SessionLock | undefined;
    let targetSessionLock: SessionLock | undefined;
    try {
      sourceSessionLock = acquireSessionLock({
        sessionId: cliArgs.sourceSessionId,
        runtime,
      });
      targetSessionLock = acquireSessionLock({
        sessionId: cliArgs.targetSessionId,
        runtime,
      });
      ensureSessionCanBeCreated({
        sessionId: cliArgs.targetSessionId,
        runtime,
      });
      const source = resumeSessionStore({
        sessionId: cliArgs.sourceSessionId,
        workspace: runtime.cwd(),
        runtime,
      });
      forkSessionStore({
        source,
        targetSessionId: cliArgs.targetSessionId,
        ...(cliArgs.forkBeforeMessage !== undefined
          ? {
              forkPoint: {
                beforeMessageId: cliArgs.forkBeforeMessage,
                optionName: "--before-message",
              },
            }
          : {}),
        runtime,
      });
      runtime.writeStdout(formatSessionForkCreated(cliArgs));
      return 0;
    } catch (error) {
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    } finally {
      targetSessionLock?.release();
      sourceSessionLock?.release();
    }
  }

  try {
    if (cliArgs.mode === "archived") {
      const catalog = listArchivedSessionCatalog({
        workspace: runtime.cwd(),
        runtime,
      });
      runtime.writeStdout(formatArchivedSessionCatalog(catalog));
      runtime.writeStderr(formatSessionCatalogWarnings(catalog.warnings));
      return 0;
    }
    const catalog = listSessionCatalog({
      workspace: runtime.cwd(),
      runtime,
    });
    runtime.writeStdout(formatSessionCatalog(catalog));
    runtime.writeStderr(formatSessionCatalogWarnings(catalog.warnings));
    return 0;
  } catch (error) {
    if (!(error instanceof SessionStoreError)) {
      throw error;
    }
    runtime.writeStderr(`${error.message}\n`);
    return 1;
  }
}
