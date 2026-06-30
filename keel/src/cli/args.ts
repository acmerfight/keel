export type { CliArgs } from "./args/types.ts";
export { USAGE } from "./args/usage.ts";

import { parseDoctorArgs } from "./args/doctor.ts";
import { parseEvalArgs } from "./args/eval.ts";
import { parseRunArgs } from "./args/run.ts";
import { parseSessionsArgs } from "./args/sessions.ts";
import { parseError, parseOk } from "./args/shared.ts";
import type { CliArgs } from "./args/types.ts";
import { USAGE } from "./args/usage.ts";

type CliArgsParseResult =
  | { readonly ok: true; readonly value: CliArgs }
  | { readonly ok: false; readonly message: string };

export function parseCliArgs(args: readonly string[]): CliArgsParseResult {
  if (args[0] === "--help" || args[0] === "-h") {
    return parseOk({ command: "help" });
  }

  if (args[0] === "--doctor") {
    return parseDoctorArgs(args.slice(1));
  }

  if (args[0] === "/undo") {
    if (args.length === 1) {
      return parseOk({ command: "undo", mode: "restore" });
    }
    if (args.length === 2 && args[1] === "--list") {
      return parseOk({ command: "undo", mode: "list" });
    }
    const unknownUndoOption = args[1] === "--list" ? args[2] : args[1];
    return parseError(`Error: unknown undo option "${unknownUndoOption}"`);
  }

  if (args[0] === "sessions") {
    return parseSessionsArgs(args.slice(1));
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
