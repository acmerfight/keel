export type { CliArgs } from "./args/types.ts";
export { USAGE } from "./args/usage.ts";

import { parseAuthArgs } from "./args/auth.ts";
import { parseConfigArgs } from "./args/config.ts";
import { parseDoctorArgs } from "./args/doctor.ts";
import { parseEvalArgs } from "./args/eval.ts";
import { parseRunArgs } from "./args/run.ts";
import { parseSessionsArgs } from "./args/sessions.ts";
import { type ParseResult, parseError, parseOk } from "./args/shared.ts";
import type { CliArgs } from "./args/types.ts";
import { USAGE } from "./args/usage.ts";

type CliArgsParseResult =
  | { readonly ok: true; readonly value: CliArgs }
  | { readonly ok: false; readonly message: string };

function parseUndoTargetIndex(raw: string | undefined): ParseResult<number> {
  if (raw === undefined || !/^[1-9][0-9]*$/u.test(raw)) {
    return parseError("Error: /undo --to requires a positive integer.");
  }
  const checkpointIndex = Number(raw);
  if (!Number.isSafeInteger(checkpointIndex)) {
    return parseError("Error: /undo --to requires a positive integer.");
  }
  return parseOk(checkpointIndex);
}

export function parseCliArgs(args: readonly string[]): CliArgsParseResult {
  if (args[0] === "--help" || args[0] === "-h") {
    return parseOk({ command: "help" });
  }

  if (args[0] === "--doctor") {
    return parseDoctorArgs(args.slice(1));
  }

  if (args[0] === "auth") {
    return parseAuthArgs(args.slice(1));
  }

  if (args[0] === "config") {
    return parseConfigArgs(args.slice(1));
  }

  if (args[0] === "/undo") {
    if (args.length === 1) {
      return parseOk({ command: "undo", mode: "restore" });
    }
    if (args.length === 2 && args[1] === "--list") {
      return parseOk({ command: "undo", mode: "list" });
    }
    if (args[1] === "--to") {
      const parsed = parseUndoTargetIndex(args[2]);
      if (!parsed.ok) return parsed;
      if (args.length > 3) {
        return parseError(`Error: unknown undo option "${args[3]}"`);
      }
      return parseOk({
        command: "undo",
        mode: "restore-through",
        checkpointIndex: parsed.value,
      });
    }
    const undoToPrefix = "--to=";
    if (args[1]?.startsWith(undoToPrefix)) {
      const parsed = parseUndoTargetIndex(args[1].slice(undoToPrefix.length));
      if (!parsed.ok) return parsed;
      if (args.length > 2) {
        return parseError(`Error: unknown undo option "${args[2]}"`);
      }
      return parseOk({
        command: "undo",
        mode: "restore-through",
        checkpointIndex: parsed.value,
      });
    }
    const unknownUndoOption = args[1] === "--list" ? args[2] : args[1];
    return parseError(`Error: unknown undo option "${unknownUndoOption}"`);
  }

  if (args[0] === "sessions") {
    return parseSessionsArgs(args.slice(1));
  }

  if (args[0] === "artifacts") {
    if (args[1] !== "show") {
      const command = args[1] ?? "";
      return parseError(
        command === ""
          ? "Error: artifacts requires a subcommand: show."
          : `Error: unknown artifacts subcommand "${command}"`,
      );
    }
    if (args[2] === undefined) {
      return parseError("Error: artifacts show requires <ref>.");
    }
    if (args.length > 3) {
      return parseError(`Error: unknown artifacts show option "${args[3]}"`);
    }
    return parseOk({ command: "artifacts", mode: "show", ref: args[2] });
  }

  if (args[0] === "skills") {
    if (args.length > 1) {
      return parseError(`Error: unknown skills option "${args[1]}"`);
    }
    return parseOk({ command: "skills" });
  }

  if (args[0] === "eval") {
    return parseEvalArgs(args.slice(1));
  }

  const parsedRunArgs = parseRunArgs(args);
  if (!parsedRunArgs.ok && parsedRunArgs.kind === "unknownOption") {
    return parseError(`${parsedRunArgs.message}\n\n${USAGE}`);
  }
  return parsedRunArgs;
}
