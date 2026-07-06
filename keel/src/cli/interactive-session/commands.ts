import { errorMessage } from "../../core/error.ts";
import { isProviderId } from "../../core/provider-id.ts";
import { sanitizeStatusLineText } from "../output.ts";
import type { ProviderSelection } from "../provider-config.ts";

interface HelpCommand {
  readonly kind: "help";
}

type UndoCommand =
  | {
      readonly kind: "undo";
      readonly mode: "restore" | "list";
    }
  | {
      readonly kind: "undo";
      readonly mode: "restore-through";
      readonly checkpointIndex: number;
    };

export interface ManualCompactCommand {
  readonly kind: "compact";
  readonly focusInstruction?: string;
}

interface ModelCommand {
  readonly kind: "model";
  readonly selection?: ProviderSelection;
}

interface SkillCommand {
  readonly kind: "skill";
}

interface StatusCommand {
  readonly kind: "status";
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
  | ModelCommand
  | SkillCommand
  | StatusCommand
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
    "  /undo              Restore the latest undo checkpoint.",
    "  /undo --list       List undo checkpoints.",
    "  /undo --to <index> Restore through a listed undo checkpoint.",
    "  /model             Show the active provider/model.",
    "  /model <provider>/<model>",
    "                     Switch the active provider/model for later prompts.",
    "  /skill             Show the active workflow skill.",
    "  /status            Show session state and recovery commands.",
    "  /compact [focus]   Summarize older conversation context with optional focus.",
    "  /fork <target-id> [--before-message <id>]",
    "                     Fork this named or resumed session without switching to it.",
    "  /fork <target-id> --pick",
    "                     Choose the fork point interactively.",
    "  /fork-points       List restored user-message fork points.",
    "",
    "Session commands:",
    "      Session ledgers are best-effort redacted at rest; live provider requests may include raw content.",
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

function parseModelCommandArgs(
  rawArgs: string | undefined,
): ModelCommand | InvalidInteractiveCommand {
  const target = rawArgs?.trim() ?? "";
  if (target === "") {
    return { kind: "model" };
  }
  if (/\s/u.test(target)) {
    return {
      kind: "invalid",
      message: "Error: usage is /model <provider>/<model>.",
    };
  }
  const slashIndex = target.indexOf("/");
  if (slashIndex <= 0 || slashIndex === target.length - 1) {
    return {
      kind: "invalid",
      message: "Error: usage is /model <provider>/<model>.",
    };
  }
  const providerId = target.slice(0, slashIndex);
  if (!isProviderId(providerId)) {
    return {
      kind: "invalid",
      message: `Error: unknown provider "${providerId}".`,
    };
  }
  return {
    kind: "model",
    selection: {
      providerId,
      model: target.slice(slashIndex + 1),
    },
  };
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

function parseUndoTargetIndex(raw: string | undefined): ParseResult<number> {
  if (raw === undefined || !/^[1-9][0-9]*$/u.test(raw)) {
    return {
      ok: false,
      message: "Error: /undo --to requires a positive integer.",
    };
  }
  const checkpointIndex = Number(raw);
  if (!Number.isSafeInteger(checkpointIndex)) {
    return {
      ok: false,
      message: "Error: /undo --to requires a positive integer.",
    };
  }
  return { ok: true, value: checkpointIndex };
}

export function parseInteractiveCommand(
  userMessage: string,
): InteractiveCommand | null {
  const trimmed = userMessage.trim();
  if (trimmed === "/help") {
    return { kind: "help" };
  }

  const statusMatch = /^\/status(?:\s+(.*))?$/u.exec(trimmed);
  if (statusMatch !== null) {
    const extraArgs = statusMatch[1]?.trim();
    if (extraArgs !== undefined && extraArgs !== "") {
      return {
        kind: "invalid",
        message: "Error: /status does not accept arguments.",
      };
    }
    return { kind: "status" };
  }

  const undoMatch = /^\/undo(?:\s+(.*))?$/u.exec(trimmed);
  if (undoMatch !== null) {
    const extraArgs = undoMatch[1]?.trim();
    if (extraArgs === undefined || extraArgs === "") {
      return { kind: "undo", mode: "restore" };
    }
    const undoArgs = extraArgs.split(/\s+/u);
    if (undoArgs.length === 1 && undoArgs[0] === "--list") {
      return { kind: "undo", mode: "list" };
    }
    if (undoArgs[0] === "--to") {
      const parsed = parseUndoTargetIndex(undoArgs[1]);
      if (!parsed.ok) return { kind: "invalid", message: parsed.message };
      if (undoArgs.length > 2) {
        return {
          kind: "invalid",
          message: `Error: unknown /undo option "${undoArgs[2]}".`,
        };
      }
      return {
        kind: "undo",
        mode: "restore-through",
        checkpointIndex: parsed.value,
      };
    }
    const undoToPrefix = "--to=";
    if (undoArgs[0]?.startsWith(undoToPrefix)) {
      const parsed = parseUndoTargetIndex(
        undoArgs[0].slice(undoToPrefix.length),
      );
      if (!parsed.ok) return { kind: "invalid", message: parsed.message };
      if (undoArgs.length > 1) {
        return {
          kind: "invalid",
          message: `Error: unknown /undo option "${undoArgs[1]}".`,
        };
      }
      return {
        kind: "undo",
        mode: "restore-through",
        checkpointIndex: parsed.value,
      };
    }
    const unknownUndoOption =
      undoArgs[0] === "--list" ? undoArgs[1] : undoArgs[0];
    return {
      kind: "invalid",
      message: `Error: unknown /undo option "${unknownUndoOption}".`,
    };
  }

  const modelMatch = /^\/model(?:\s+(.*))?$/u.exec(trimmed);
  if (modelMatch !== null) {
    return parseModelCommandArgs(modelMatch[1]);
  }

  const skillMatch = /^\/skill(?:\s+(.*))?$/u.exec(trimmed);
  if (skillMatch !== null) {
    const extraArgs = skillMatch[1]?.trim();
    if (extraArgs !== undefined && extraArgs !== "") {
      return {
        kind: "invalid",
        message: "Error: /skill does not accept arguments.",
      };
    }
    return { kind: "skill" };
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
  return `${sanitizeStatusLineText(errorMessage(error))}\n`;
}

export function undoRestoredContextMessage(filePath: string): string {
  return `Keel local command /undo restored ${filePath}. Treat this as workspace state, not as a new user request.`;
}

export function formatManualCompactionFailure(error: unknown): string {
  return `Context compaction failed: ${sanitizeStatusLineText(errorMessage(error))}\n`;
}

export function formatForkRequiresNamedSession(
  command: "/fork" | "/fork-points",
): string {
  return `Error: ${command} requires a named session. Start with --session or --resume.\n`;
}
