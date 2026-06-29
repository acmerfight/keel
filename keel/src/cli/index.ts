#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseCliArgs, USAGE } from "./args.ts";
import { runForkPointsCommand } from "./fork-points-command.ts";
import { runInteractiveCli } from "./interactive-run.ts";
import { runOneShotCli } from "./one-shot-run.ts";
import {
  type CliRuntime,
  exitWithCliRuntimeError,
  withCliRuntimeErrorBoundary,
} from "./runtime.ts";
import { runSessionsCommand } from "./sessions-command.ts";
import {
  runDoctorCommand,
  runEvalCommand,
  runSkillsCommand,
  runUndoCommand,
} from "./top-level-commands.ts";

async function runCliMainUnsafe(runtime: CliRuntime): Promise<number> {
  const parsedCliArgs = parseCliArgs(runtime.args);
  if (!parsedCliArgs.ok) {
    runtime.writeStderr(`${parsedCliArgs.message}\n`);
    return 1;
  }
  const cliArgs = parsedCliArgs.value;

  if (cliArgs.command === "help") {
    runtime.writeStdout(`${USAGE}\n`);
    return 0;
  }

  if (cliArgs.command === "doctor") {
    return await runDoctorCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "eval") {
    return await runEvalCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "undo") {
    return runUndoCommand(runtime);
  }

  if (cliArgs.command === "skills") {
    return runSkillsCommand(runtime);
  }

  if (cliArgs.command === "sessions") {
    return runSessionsCommand(cliArgs, runtime);
  }

  const userMessage = cliArgs.userMessage;
  if (cliArgs.forkPoints && cliArgs.resumeSessionId !== undefined) {
    return runForkPointsCommand(cliArgs, runtime, cliArgs.resumeSessionId);
  }
  if (
    userMessage !== undefined &&
    (cliArgs.sessionId !== undefined || cliArgs.resumeSessionId !== undefined)
  ) {
    runtime.writeStderr(
      "Error: --session and --resume are only supported for interactive sessions.\n",
    );
    return 1;
  }
  if (!userMessage && cliArgs.transcriptFile !== undefined) {
    runtime.writeStderr(
      "Error: --transcript is only supported for one-shot runs.\n",
    );
    return 1;
  }
  if (!userMessage) {
    return await runInteractiveCli(cliArgs, runtime);
  }

  return await runOneShotCli(cliArgs, runtime, userMessage);
}

export async function runCliMain(runtime: CliRuntime): Promise<number> {
  return await withCliRuntimeErrorBoundary(runtime, () =>
    runCliMainUnsafe(runtime),
  );
}

/* v8 ignore start: real process adapter is exercised by CLI subprocess tests. */
function defaultRuntime(): CliRuntime {
  return {
    args: process.argv.slice(2),
    cliEntry: import.meta.filename,
    cwd: () => process.cwd(),
    env: (key) => process.env[key],
    input: process.stdin,
    platform: process.platform,
    stderrIsTTY: process.stderr.isTTY === true,
    now: () => Date.now(),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    onSigint: (handler) => {
      process.on("SIGINT", handler);
    },
    offSigint: (handler) => {
      process.off("SIGINT", handler);
    },
    forceExit: (code) => process.exit(code),
  };
}

export async function main(): Promise<void> {
  process.exitCode = await runCliMain(defaultRuntime());
}

function installProcessRuntimeErrorHandlers(): void {
  process.on("uncaughtException", exitWithCliRuntimeError);
  process.on("unhandledRejection", exitWithCliRuntimeError);
}

// process.argv[1] keeps the launch path; npm/pnpm install bins as symlinks,
// so resolve to the real path before comparing against the resolved module URL.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  installProcessRuntimeErrorHandlers();
  await main();
}
/* v8 ignore stop */
