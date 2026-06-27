export type { CliArgs } from "./args/types.ts";
export { USAGE } from "./args/usage.ts";

import { parseDoctorArgs } from "./args/doctor.ts";
import { parseEvalArgs } from "./args/eval.ts";
import { parseRunArgs } from "./args/run.ts";
import { parseSessionsArgs } from "./args/sessions.ts";
import { parseError, parseOk } from "./args/shared.ts";
import type { CliArgs } from "./args/types.ts";

type CliArgsParseResult =
  | { readonly ok: true; readonly value: CliArgs }
  | { readonly ok: false; readonly message: string };

export function parseCliArgs(args: readonly string[]): CliArgsParseResult {
  if (args[0] === "--doctor") {
    return parseDoctorArgs(args.slice(1));
  }

  if (args[0] === "/undo") {
    return parseOk({ command: "undo" });
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

  return parseRunArgs(args);
}
