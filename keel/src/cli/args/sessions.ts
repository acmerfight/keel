import {
  type ParseResult,
  parseBeforeMessage,
  parseError,
  parseOk,
} from "./shared.ts";
import type { SessionsCliArgs, SessionsForkCliArgs } from "./types.ts";

function parseSessionsForkArgs(
  args: readonly string[],
): ParseResult<SessionsForkCliArgs> {
  const sourceSessionId = args[0];
  const targetSessionId = args[1];
  if (
    sourceSessionId === undefined ||
    sourceSessionId === "" ||
    targetSessionId === undefined ||
    targetSessionId === ""
  ) {
    return parseError("Error: sessions fork requires <source-id> <target-id>.");
  }

  let forkBeforeMessage: string | undefined;
  const beforeMessagePrefix = "--before-message=";
  const optionArgs = args.slice(2);
  let skipNext = false;
  for (const [index, arg] of optionArgs.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--before-message") {
      const parsed = parseBeforeMessage(optionArgs[index + 1]);
      if (!parsed.ok) return parsed;
      forkBeforeMessage = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(beforeMessagePrefix)) {
      const parsed = parseBeforeMessage(arg.slice(beforeMessagePrefix.length));
      if (!parsed.ok) return parsed;
      forkBeforeMessage = parsed.value;
      continue;
    }

    return parseError(`Error: unknown sessions fork option "${arg}"`);
  }

  return parseOk({
    command: "sessions",
    mode: "fork",
    sourceSessionId,
    targetSessionId,
    ...(forkBeforeMessage !== undefined ? { forkBeforeMessage } : {}),
  });
}

export function parseSessionsArgs(
  args: readonly string[],
): ParseResult<SessionsCliArgs> {
  const subcommand = args[0];
  if (subcommand === undefined) {
    return parseOk({ command: "sessions", mode: "list" });
  }
  if (subcommand === "fork") {
    return parseSessionsForkArgs(args.slice(1));
  }
  return parseError(`Error: unknown sessions option "${subcommand}"`);
}
