import { sanitizeStatusLineText } from "../output.ts";

interface HelpCommand {
  readonly kind: "help";
}

interface UndoCommand {
  readonly kind: "undo";
}

export interface ManualCompactCommand {
  readonly kind: "compact";
  readonly focusInstruction?: string;
}

interface ForkCommand {
  readonly kind: "fork";
  readonly targetSessionId: string;
  readonly beforeMessageId?: string;
  readonly pick?: true;
}

interface ForkPointsCommand {
  readonly kind: "fork-points";
}

interface InvalidInteractiveCommand {
  readonly kind: "invalid";
  readonly message: string;
}

export type InteractiveCommand =
  | HelpCommand
  | UndoCommand
  | ManualCompactCommand
  | ForkPointsCommand
  | ForkCommand
  | InvalidInteractiveCommand;

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export function formatInteractiveHelp(): string {
  return [
    "Interactive commands:",
    "  /help              Show this help.",
    "  /undo              Restore the last edit checkpoint.",
    "  /compact [focus]   Summarize older conversation context with optional focus.",
    "  /fork <target-id> [--before-message <id>]",
    "                     Fork this named or resumed session without switching to it.",
    "  /fork <target-id> --pick",
    "                     Choose the fork point interactively.",
    "  /fork-points       List restored user-message fork points.",
    "",
    "Session commands:",
    "  keel sessions",
    "      List saved interactive sessions.",
    "  keel --resume <id>",
    "      Resume a saved interactive session.",
    "  keel --resume <id> --fork-points",
    "      List restored user-message fork points.",
    "  keel sessions fork <source-id> <target-id> [--before-message <id>]",
    "      Fork a saved session into a new session.",
    "",
    "Controls:",
    "  Ctrl-D             Exit when input closes.",
    "  Ctrl-C             Interrupt the active turn or exit while idle.",
    "",
  ].join("\n");
}

function parseForkBeforeMessage(raw: string | undefined): ParseResult<string> {
  if (raw === undefined || raw === "") {
    return { ok: false, message: "Error: --before-message requires a value." };
  }
  return { ok: true, value: raw };
}

function parseForkCommandArgs(
  rawArgs: string | undefined,
): ForkCommand | InvalidInteractiveCommand {
  const trimmedArgs = rawArgs?.trim() ?? "";
  if (trimmedArgs === "") {
    return {
      kind: "invalid",
      message: "Error: /fork requires <target-id>.",
    };
  }

  const args = trimmedArgs.split(/\s+/u);
  const targetSessionId = args[0];
  if (targetSessionId === undefined || targetSessionId.startsWith("-")) {
    return {
      kind: "invalid",
      message: "Error: /fork requires <target-id>.",
    };
  }

  let beforeMessageId: string | undefined;
  let pick = false;
  const beforeMessagePrefix = "--before-message=";
  const optionArgs = args.slice(1);
  let skipNext = false;
  for (const [index, arg] of optionArgs.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--pick") {
      pick = true;
      continue;
    }

    if (arg === "--before-message") {
      const parsed = parseForkBeforeMessage(optionArgs[index + 1]);
      if (!parsed.ok) {
        return { kind: "invalid", message: parsed.message };
      }
      beforeMessageId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(beforeMessagePrefix)) {
      const parsed = parseForkBeforeMessage(
        arg.slice(beforeMessagePrefix.length),
      );
      if (!parsed.ok) {
        return { kind: "invalid", message: parsed.message };
      }
      beforeMessageId = parsed.value;
      continue;
    }

    return {
      kind: "invalid",
      message: `Error: unknown /fork option "${arg}".`,
    };
  }

  if (pick && beforeMessageId !== undefined) {
    return {
      kind: "invalid",
      message: "Error: --pick cannot be combined with --before-message.",
    };
  }

  return {
    kind: "fork",
    targetSessionId,
    ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
    ...(pick ? { pick } : {}),
  };
}

export function parseInteractiveCommand(
  userMessage: string,
): InteractiveCommand | null {
  const trimmed = userMessage.trim();
  if (trimmed === "/help") {
    return { kind: "help" };
  }

  const undoMatch = /^\/undo(?:\s+(.*))?$/u.exec(trimmed);
  if (undoMatch !== null) {
    const extraArgs = undoMatch[1]?.trim();
    if (extraArgs !== undefined && extraArgs !== "") {
      return {
        kind: "invalid",
        message: "Error: /undo does not accept arguments.",
      };
    }
    return { kind: "undo" };
  }

  const forkPointsMatch = /^\/fork-points(?:\s+(.*))?$/u.exec(trimmed);
  if (forkPointsMatch !== null) {
    const extraArgs = forkPointsMatch[1]?.trim();
    if (extraArgs !== undefined && extraArgs !== "") {
      return {
        kind: "invalid",
        message: "Error: /fork-points does not accept arguments.",
      };
    }
    return { kind: "fork-points" };
  }

  const forkMatch = /^\/fork(?:\s+(.*))?$/u.exec(trimmed);
  if (forkMatch !== null) {
    return parseForkCommandArgs(forkMatch[1]);
  }

  const compactMatch = /^\/compact(?:\s+(.*))?$/u.exec(trimmed);
  if (compactMatch === null) {
    return null;
  }
  const focusInstruction = compactMatch[1]?.trim();
  if (focusInstruction === undefined || focusInstruction === "") {
    return { kind: "compact" };
  }
  return { kind: "compact", focusInstruction };
}

export function formatInteractiveCommandFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${sanitizeStatusLineText(message)}\n`;
}

export function undoRestoredContextMessage(filePath: string): string {
  return `Keel local command /undo restored ${filePath}. Treat this as workspace state, not as a new user request.`;
}

export function formatManualCompactionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Context compaction failed: ${sanitizeStatusLineText(message)}\n`;
}

export function formatForkRequiresNamedSession(
  command: "/fork" | "/fork-points",
): string {
  return `Error: ${command} requires a named session. Start with --session or --resume.\n`;
}
