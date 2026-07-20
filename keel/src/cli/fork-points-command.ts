import type { CliArgs } from "./args.ts";
import {
  formatExternalSessionForkPoints,
  sessionForkPointsFromStoredMessages,
} from "./fork-points.ts";
import type { CliRuntime } from "./runtime.ts";
import { resumeSessionStore, SessionStoreError } from "./session-store.ts";

type ForkPointsRunCliArgs = Extract<
  CliArgs,
  { readonly command: "run"; readonly mode: "fork-points" }
>;

export function runForkPointsCommand(
  cliArgs: ForkPointsRunCliArgs,
  runtime: CliRuntime,
): number {
  try {
    const session = resumeSessionStore({
      sessionId: cliArgs.sessionId,
      workspace: runtime.cwd(),
      runtime,
    });
    for (const requested of cliArgs.skillNames ?? []) {
      const alreadyActive = session.activeSkillIds.some((id) => {
        const activation = session.skillActivations.findLast(
          (candidate) => candidate.descriptorId === id,
        );
        return (
          activation?.name === requested ||
          activation?.qualifiedName === requested
        );
      });
      if (!alreadyActive) {
        throw new SessionStoreError(
          `Error: session "${session.id}" does not have active workflow skill "${requested}"; --fork-points cannot activate skills.`,
        );
      }
    }
    runtime.writeStdout(
      formatExternalSessionForkPoints(
        sessionForkPointsFromStoredMessages({
          sessionId: session.id,
          storedMessages: session.storedMessages,
        }),
      ),
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
