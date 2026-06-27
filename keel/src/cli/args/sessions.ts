import {
  type ParseResult,
  parseBeforeMessage,
  parseError,
  parseOk,
} from "./shared.ts";
import type {
  SessionsCliArgs,
  SessionsForkCliArgs,
  SessionsShowCliArgs,
} from "./types.ts";

const DEFAULT_SESSIONS_SHOW_TIMELINE_LIMIT = 20;

function parsePositiveShowLimit(
  value: string | undefined,
): ParseResult<number> {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    return parseError("Error: --limit requires a positive integer.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    return parseError("Error: --limit requires a positive integer.");
  }
  return parseOk(limit);
}

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

function parseSessionsShowArgs(
  args: readonly string[],
): ParseResult<SessionsShowCliArgs> {
  const sessionId = args[0];
  if (sessionId === undefined || sessionId === "") {
    return parseError("Error: sessions show requires <id>.");
  }

  let timelineLimit: number | null = DEFAULT_SESSIONS_SHOW_TIMELINE_LIMIT;
  let sawLimit = false;
  let showAll = false;
  const limitPrefix = "--limit=";
  const optionArgs = args.slice(1);
  let skipNext = false;
  for (const [index, arg] of optionArgs.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--all") {
      showAll = true;
      continue;
    }

    if (arg === "--limit") {
      const parsed = parsePositiveShowLimit(optionArgs[index + 1]);
      if (!parsed.ok) return parsed;
      sawLimit = true;
      timelineLimit = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(limitPrefix)) {
      const parsed = parsePositiveShowLimit(arg.slice(limitPrefix.length));
      if (!parsed.ok) return parsed;
      sawLimit = true;
      timelineLimit = parsed.value;
      continue;
    }

    return parseError(`Error: unknown sessions show option "${arg}"`);
  }

  if (showAll && sawLimit) {
    return parseError("Error: --all cannot be combined with --limit.");
  }

  return parseOk({
    command: "sessions",
    mode: "show",
    sessionId,
    timelineLimit: showAll ? null : timelineLimit,
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
  if (subcommand === "show") {
    return parseSessionsShowArgs(args.slice(1));
  }
  return parseError(`Error: unknown sessions option "${subcommand}"`);
}
