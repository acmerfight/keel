import type { CliArgs } from "./args.ts";
import {
  formatExternalSessionForkPoints,
  sessionForkPointsFromStoredMessages,
} from "./fork-points.ts";
import { ensureResumedWorkflowSkillMatchesRequest } from "./resumed-workflow-skill.ts";
import type { CliRuntime } from "./runtime.ts";
import { resumeSessionStore, SessionStoreError } from "./session-store.ts";

type RunCliArgs = Extract<CliArgs, { readonly command: "run" }>;

export function runForkPointsCommand(
  cliArgs: RunCliArgs,
  runtime: CliRuntime,
  resumeSessionId: string,
): number {
  try {
    const session = resumeSessionStore({
      sessionId: resumeSessionId,
      workspace: runtime.cwd(),
      runtime,
    });
    ensureResumedWorkflowSkillMatchesRequest({
      session,
      ...(cliArgs.skillName !== undefined
        ? { requestedSkillName: cliArgs.skillName }
        : {}),
    });
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
    /* v8 ignore next 3: resumeSessionStore reports supported fork-point failures as SessionStoreError. */
    if (!(error instanceof SessionStoreError)) {
      throw error;
    }
    runtime.writeStderr(`${error.message}\n`);
    return 1;
  }
}
