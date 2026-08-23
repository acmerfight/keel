#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { parseCliArgs, USAGE } from "./args.ts";
import { runForkPointsCommand } from "./fork-points-command.ts";
import { runHeadlessGoalCli } from "./headless-goal-run.ts";
import { runInteractiveCli } from "./interactive-run.ts";
import { runMcpCommand } from "./mcp-command.ts";
import { createNativeMcpSecretBackend } from "./mcp-secret-backend.ts";
import { runMemoryCommand } from "./memory-command.ts";
import { runOneShotCli } from "./one-shot-run.ts";
import { openExternalUrl } from "./open-external-url.ts";
import {
  type CliRuntime,
  exitWithCliRuntimeError,
  withCliRuntimeErrorBoundary,
} from "./runtime.ts";
import { runSessionsCommand } from "./sessions-command.ts";
import {
  runArtifactsCommand,
  runAuthCommand,
  runConfigCommand,
  runDoctorCommand,
  runEvalCommand,
  runSetupCommand,
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

  if (cliArgs.command === "auth") {
    return await runAuthCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "config") {
    return runConfigCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "mcp") {
    return await runMcpCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "setup") {
    return await runSetupCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "eval") {
    return await runEvalCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "goal") {
    return await runHeadlessGoalCli(cliArgs, runtime);
  }

  if (cliArgs.command === "undo") {
    return runUndoCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "artifacts") {
    return await runArtifactsCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "skills") {
    return runSkillsCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "memory") {
    return await runMemoryCommand(cliArgs, runtime);
  }

  if (cliArgs.command === "sessions") {
    return runSessionsCommand(cliArgs, runtime);
  }

  if (cliArgs.mode === "fork-points") {
    return runForkPointsCommand(cliArgs, runtime);
  }
  if (cliArgs.mode === "interactive") {
    return await runInteractiveCli(cliArgs, runtime);
  }
  return await runOneShotCli(cliArgs, runtime);
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
    mcpSecretBackend: createNativeMcpSecretBackend(),
    openExternalUrl: async (url) =>
      await openExternalUrl(url, process.platform),
    sleep: async (milliseconds) => {
      await delay(milliseconds);
    },
    stderrIsTTY: process.stderr.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    createInteractiveTerminal: () => new ProcessTerminal(),
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
