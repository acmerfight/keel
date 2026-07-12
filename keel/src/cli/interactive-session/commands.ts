import { errorMessage } from "../../core/error.ts";
import { isProviderId } from "../../core/provider-id.ts";
import {
  formatSessionGoalCompletionEvidenceSummary,
  formatSessionGoalDuration,
  formatSessionGoalRuntimeOutcomeSummary,
  formatSessionGoalSummary,
  normalizeSessionGoalCompletionCommand,
  normalizeSessionGoalCompletionCriterion,
  normalizeSessionGoalObjective,
  type SessionGoal,
  type SessionGoalBudget,
  type SessionGoalCriterionKind,
} from "../../core/session-goal.ts";
import {
  parseGoalDuration,
  parseGoalPositiveIntegerOption,
  parseGoalVerificationTimeout,
} from "../goal-options.ts";
import { sanitizeStatusLineText } from "../output.ts";
import { redactTextForPersistence } from "../persistence-redaction.ts";
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
  readonly lookup?: string;
  readonly arguments?: string;
}

interface StatusCommand {
  readonly kind: "status";
}

interface TitleCommand {
  readonly kind: "title";
  readonly title?: string;
}

type GoalCommand =
  | {
      readonly kind: "goal";
      readonly action:
        | "show"
        | "show_budget"
        | "pause"
        | "resume"
        | "complete"
        | "clear"
        | "clear_budget";
    }
  | {
      readonly kind: "goal";
      readonly action: "set";
      readonly objective: string;
    }
  | {
      readonly kind: "goal";
      readonly action: "launch";
      readonly objective: string;
      readonly budget: SessionGoalBudget;
      readonly criterion:
        | {
            readonly kind: "command";
            readonly command: string;
            readonly verificationTimeoutMs?: number;
          }
        | {
            readonly kind: "assertion";
            readonly assertion: string;
          };
    }
  | {
      readonly kind: "goal";
      readonly action: "verify";
      readonly command: string;
      readonly verificationTimeoutMs?: number;
    }
  | {
      readonly kind: "goal";
      readonly action: "criterion";
      readonly criterionKind: SessionGoalCriterionKind;
      readonly criterion: string;
    }
  | {
      readonly kind: "goal";
      readonly action: "budget";
      readonly budget: SessionGoalBudget;
    };

interface TasksCommand {
  readonly kind: "tasks";
}

interface DiffCommand {
  readonly kind: "diff";
}

type ApprovalsCommand =
  | {
      readonly kind: "approvals";
      readonly action: "list" | "clear";
    }
  | {
      readonly kind: "approvals";
      readonly action: "revoke";
      readonly index: number;
    };

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
  readonly scope?: "goal";
}

export type InteractiveCommand =
  | HelpCommand
  | UndoCommand
  | ModelCommand
  | SkillCommand
  | StatusCommand
  | TitleCommand
  | GoalCommand
  | TasksCommand
  | DiffCommand
  | ApprovalsCommand
  | ManualCompactCommand
  | ForkPointsCommand
  | ForkCommand
  | InvalidInteractiveCommand;

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export function formatInteractiveHelp(): string {
  return [
    "Workflow:",
    "  Keep one saved session open for a task; send follow-ups or corrections here until it is done.",
    "  Input typed while a turn runs is applied at the next safe model request.",
    "  Use /status for the resume command, /tasks for progress, /diff for changes, and /undo to roll back.",
    "",
    "Interactive commands:",
    "  /help              Show this help.",
    "  /undo              Restore the latest undo checkpoint.",
    "  /undo --list       List undo checkpoints.",
    "  /undo --to <index> Restore through a listed undo checkpoint.",
    "  /model             Show the active provider/model.",
    "  /model <provider>/<model>",
    "                     Switch the active provider/model for later prompts.",
    "  /skill             Show active workflow skills.",
    "  /skill <name|scope:name|scope:root-id:name> [task]",
    "                     Activate a skill, then optionally run a task.",
    "  /status            Show session state and recovery commands.",
    "  /title [text]      Show or set this saved session title.",
    "  /goal [condition]  Show or start a goal with this completion condition.",
    '  /goal --objective "<condition>"',
    '                     (--verify "<cmd>" [--timeout 30s]',
    '                      | --done-when "<criterion>")',
    "                     [--turns N] [--tokens N] [--time 30m]",
    "                     Atomically configure and start a goal.",
    "  /goal verify [--timeout 30s] <cmd>",
    "                     Set the command that proves the goal is done.",
    "  /goal done-when <criterion>",
    "                     Set an assertion completion criterion.",
    "  /goal pause        Pause the current session goal.",
    "  /goal resume       Resume and continue a paused, blocked, or limited goal.",
    "  /goal budget [--turns N] [--tokens N] [--time 30m]",
    "                     Show or update goal execution budgets.",
    "  /goal budget clear Clear goal budgets without resetting usage.",
    "  /goal complete     Mark the current session goal completed.",
    "  /goal clear        Clear the current session goal.",
    "  /tasks             Show current session tasks.",
    "  /diff              Show current git status and diff.",
    "  /approvals         List active bash approvals.",
    "  /approvals revoke <index>",
    "                     Revoke one active bash approval.",
    "  /approvals clear   Clear active bash approvals.",
    "  /compact [focus]   Summarize older conversation context with optional focus.",
    "  /fork <target-id> [--before-message <id>]",
    "                     Fork this saved session without switching to it.",
    "  /fork <target-id> --pick",
    "                     Choose the fork point interactively.",
    "  /fork-points       List restored user-message fork points.",
    "",
    "Session commands:",
    "      Interactive sessions save ledgers by default with best-effort at-rest redaction.",
    "      Live provider requests may include raw content.",
    "  keel --ephemeral",
    "      Start an interactive session without saving a ledger.",
    "  keel --session <id>",
    "      Start a saved interactive session with a chosen id.",
    "  keel sessions",
    "      List saved interactive sessions.",
    "  keel --resume",
    "      Resume the latest saved interactive session for this workspace.",
    "  keel --resume --pick",
    "      Choose a saved interactive session for this workspace.",
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

function parseApprovalIndex(raw: string | undefined): ParseResult<number> {
  if (raw === undefined || !/^[1-9][0-9]*$/u.test(raw)) {
    return {
      ok: false,
      message: "Error: /approvals revoke requires a positive integer.",
    };
  }
  const approvalIndex = Number(raw);
  if (!Number.isSafeInteger(approvalIndex)) {
    return {
      ok: false,
      message: "Error: /approvals revoke requires a positive integer.",
    };
  }
  return { ok: true, value: approvalIndex };
}

function parseApprovalsCommandArgs(
  rawArgs: string | undefined,
): ApprovalsCommand | InvalidInteractiveCommand {
  const trimmedArgs = rawArgs?.trim() ?? "";
  if (trimmedArgs === "") {
    return { kind: "approvals", action: "list" };
  }

  const args = trimmedArgs.split(/\s+/u);
  if (args[0] === "clear") {
    if (args.length > 1) {
      return {
        kind: "invalid",
        message: `Error: unknown /approvals argument "${args[1]}".`,
      };
    }
    return { kind: "approvals", action: "clear" };
  }
  if (args[0] === "revoke") {
    const parsed = parseApprovalIndex(args[1]);
    if (!parsed.ok) {
      return { kind: "invalid", message: parsed.message };
    }
    if (args.length > 2) {
      return {
        kind: "invalid",
        message: `Error: unknown /approvals argument "${args[2]}".`,
      };
    }
    return { kind: "approvals", action: "revoke", index: parsed.value };
  }

  return {
    kind: "invalid",
    message: `Error: unknown /approvals argument "${args[0]}".`,
  };
}

function parseGoalCommandArgs(
  rawArgs: string | undefined,
): GoalCommand | InvalidInteractiveCommand {
  const trimmedArgs = rawArgs?.trim() ?? "";
  if (trimmedArgs === "" || trimmedArgs === "status") {
    return { kind: "goal", action: "show" };
  }
  if (trimmedArgs === "complete") {
    return { kind: "goal", action: "complete" };
  }
  if (trimmedArgs === "pause") {
    return { kind: "goal", action: "pause" };
  }
  if (trimmedArgs === "resume") {
    return { kind: "goal", action: "resume" };
  }
  if (trimmedArgs === "budget") {
    return { kind: "goal", action: "show_budget" };
  }
  if (trimmedArgs === "budget clear") {
    return { kind: "goal", action: "clear_budget" };
  }
  if (trimmedArgs.startsWith("budget ")) {
    return parseGoalBudgetArgs(trimmedArgs.slice("budget ".length));
  }
  if (trimmedArgs === "clear") {
    return { kind: "goal", action: "clear" };
  }
  if (trimmedArgs.startsWith("--")) {
    return parseAtomicGoalArgs(trimmedArgs);
  }
  if (trimmedArgs === "verify") {
    return {
      kind: "invalid",
      message: "Error: /goal verify requires a command.",
    };
  }
  if (trimmedArgs === "done-when") {
    return {
      kind: "invalid",
      message: "Error: /goal done-when requires a completion criterion.",
    };
  }
  const verifyPrefix = "verify ";
  if (trimmedArgs.startsWith(verifyPrefix)) {
    return parseGoalVerifyArgs(trimmedArgs.slice(verifyPrefix.length));
  }
  const doneWhenPrefix = "done-when ";
  if (trimmedArgs.startsWith(doneWhenPrefix)) {
    const criterion = normalizeSessionGoalCompletionCriterion(
      trimmedArgs.slice(doneWhenPrefix.length),
    );
    return {
      kind: "goal",
      action: "criterion",
      criterionKind: "assertion",
      criterion,
    };
  }
  const unknownSubcommand = parseUnknownGoalSubcommand(trimmedArgs);
  if (unknownSubcommand !== null) {
    return unknownSubcommand;
  }
  return {
    kind: "goal",
    action: "set",
    objective: normalizeSessionGoalObjective(trimmedArgs),
  };
}

function parseGoalVerifyArgs(
  rawArgs: string,
):
  | Extract<GoalCommand, { readonly action: "verify" }>
  | InvalidInteractiveCommand {
  const trimmedArgs = rawArgs.trim();
  if (!trimmedArgs.startsWith("--timeout")) {
    return {
      kind: "goal",
      action: "verify",
      command: normalizeSessionGoalCompletionCommand(trimmedArgs),
    };
  }
  const match = /^--timeout(?:\s+(\S+))?(?:\s+([\s\S]+))?$/u.exec(trimmedArgs);
  const parsed = parseGoalVerificationTimeout(match?.[1]);
  if (!parsed.ok) {
    return { kind: "invalid", message: parsed.message };
  }
  const command = normalizeSessionGoalCompletionCommand(match?.[2] ?? "");
  if (command === "") {
    return {
      kind: "invalid",
      message:
        "Error: /goal verify requires a command after --timeout <duration>.",
    };
  }
  return {
    kind: "goal",
    action: "verify",
    command,
    verificationTimeoutMs: parsed.value,
  };
}

function parseGoalBudgetValues(
  rawArgs: string,
): ParseResult<SessionGoalBudget> {
  const trimmedArgs = rawArgs.trim();
  const args = trimmedArgs.split(/\s+/u);
  const budget: {
    turns?: number;
    tokens?: number;
    activeTimeMs?: number;
  } = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const rawValue = args[index + 1];
    if (option === "--turns" || option === "--tokens") {
      const parsed = parseGoalPositiveIntegerOption(option, rawValue);
      if (!parsed.ok) return parsed;
      if (option === "--turns") budget.turns = parsed.value;
      else budget.tokens = parsed.value;
      continue;
    }
    if (option === "--time") {
      const parsed = parseGoalDuration(rawValue);
      if (!parsed.ok) return parsed;
      budget.activeTimeMs = parsed.value;
      continue;
    }
    return {
      ok: false,
      message: `Error: unknown /goal budget option "${option}".`,
    };
  }
  return { ok: true, value: budget };
}

function parseGoalBudgetArgs(
  rawArgs: string,
): GoalCommand | InvalidInteractiveCommand {
  const parsed = parseGoalBudgetValues(rawArgs);
  return parsed.ok
    ? { kind: "goal", action: "budget", budget: parsed.value }
    : { kind: "invalid", message: parsed.message };
}

interface AtomicGoalToken {
  readonly value: string;
  readonly quoted: boolean;
}

function tokenizeAtomicGoalArgs(
  rawArgs: string,
): ParseResult<readonly AtomicGoalToken[]> {
  const tokens: AtomicGoalToken[] = [];
  let index = 0;
  while (index < rawArgs.length) {
    while (/\s/u.test(rawArgs.charAt(index))) index += 1;

    if (rawArgs[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < rawArgs.length) {
        const character = rawArgs[index];
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          break;
        }
        index += 1;
      }
      if (rawArgs[index] !== '"') {
        return {
          ok: false,
          message:
            "Error: atomic goal options require valid JSON-style double-quoted strings.",
        };
      }
      const encoded = rawArgs.slice(start, index + 1);
      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch {
        return {
          ok: false,
          message:
            "Error: atomic goal options require valid JSON-style double-quoted strings.",
        };
      }
      index += 1;
      if (
        typeof value !== "string" ||
        (index < rawArgs.length && !/\s/u.test(rawArgs[index] ?? ""))
      ) {
        return {
          ok: false,
          message:
            "Error: atomic goal options require valid JSON-style double-quoted strings.",
        };
      }
      tokens.push({ value, quoted: true });
      continue;
    }

    const start = index;
    while (index < rawArgs.length && !/\s/u.test(rawArgs.charAt(index))) {
      index += 1;
    }
    tokens.push({ value: rawArgs.slice(start, index), quoted: false });
  }
  return { ok: true, value: tokens };
}

function parseAtomicGoalArgs(
  trimmedArgs: string,
): GoalCommand | InvalidInteractiveCommand {
  const tokenized = tokenizeAtomicGoalArgs(trimmedArgs);
  if (!tokenized.ok) {
    return { kind: "invalid", message: tokenized.message };
  }

  let objective: string | undefined;
  let command: string | undefined;
  let assertion: string | undefined;
  let verificationTimeoutMs: number | undefined;
  const budget: {
    turns?: number;
    tokens?: number;
    activeTimeMs?: number;
  } = {};
  const seenOptions = new Set<string>();
  const tokens = tokenized.value;
  for (const [index, optionToken] of tokens.entries()) {
    if (index % 2 !== 0) continue;
    const option = optionToken.value;
    const valueToken = tokens[index + 1];
    if (seenOptions.has(option)) {
      return {
        kind: "invalid",
        message: `Error: duplicate atomic goal option "${option}".`,
      };
    }
    seenOptions.add(option);

    if (
      option === "--objective" ||
      option === "--verify" ||
      option === "--done-when"
    ) {
      if (valueToken?.quoted !== true) {
        return {
          kind: "invalid",
          message: `Error: ${option} requires a non-empty double-quoted value.`,
        };
      }
      const normalized =
        option === "--objective"
          ? normalizeSessionGoalObjective(valueToken.value)
          : option === "--verify"
            ? normalizeSessionGoalCompletionCommand(valueToken.value)
            : normalizeSessionGoalCompletionCriterion(valueToken.value);
      if (normalized === "") {
        return {
          kind: "invalid",
          message: `Error: ${option} requires a non-empty double-quoted value.`,
        };
      }
      if (option === "--objective") objective = normalized;
      else if (option === "--verify") command = normalized;
      else assertion = normalized;
      continue;
    }

    if (option === "--turns" || option === "--tokens") {
      const parsed = parseGoalPositiveIntegerOption(option, valueToken?.value);
      if (!parsed.ok) return { kind: "invalid", message: parsed.message };
      if (option === "--turns") budget.turns = parsed.value;
      else budget.tokens = parsed.value;
      continue;
    }
    if (option === "--time") {
      const parsed = parseGoalDuration(valueToken?.value);
      if (!parsed.ok) return { kind: "invalid", message: parsed.message };
      budget.activeTimeMs = parsed.value;
      continue;
    }
    if (option === "--timeout") {
      const parsed = parseGoalVerificationTimeout(valueToken?.value);
      if (!parsed.ok) return { kind: "invalid", message: parsed.message };
      verificationTimeoutMs = parsed.value;
      continue;
    }
    return {
      kind: "invalid",
      message: `Error: unknown atomic goal option "${option}".`,
    };
  }

  if (objective === undefined) {
    return {
      kind: "invalid",
      message: 'Error: an atomic goal requires --objective "<objective>".',
    };
  }
  if (command === undefined) {
    if (assertion === undefined) {
      return {
        kind: "invalid",
        message:
          'Error: an atomic goal requires exactly one of --verify "<command>" or --done-when "<criterion>".',
      };
    }
    if (verificationTimeoutMs !== undefined) {
      return {
        kind: "invalid",
        message: "Error: --timeout is only valid with --verify.",
      };
    }
    return {
      kind: "goal",
      action: "launch",
      objective,
      budget,
      criterion: { kind: "assertion", assertion },
    };
  }
  if (assertion !== undefined) {
    return {
      kind: "invalid",
      message: "Error: --verify and --done-when are mutually exclusive.",
    };
  }
  return {
    kind: "goal",
    action: "launch",
    objective,
    budget,
    criterion: {
      kind: "command",
      command,
      ...(verificationTimeoutMs === undefined ? {} : { verificationTimeoutMs }),
    },
  };
}

function parseUnknownGoalSubcommand(
  trimmedArgs: string,
): InvalidInteractiveCommand | null {
  const firstArg = trimmedArgs.replace(/\s.*$/u, "");
  if (firstArg.startsWith("done-when")) {
    return {
      kind: "invalid",
      message: `Error: unknown /goal subcommand "${firstArg}". Did you mean /goal done-when <criterion>?`,
    };
  }
  if (/^verify[^a-z]/u.test(firstArg)) {
    return {
      kind: "invalid",
      message: `Error: unknown /goal subcommand "${firstArg}". Did you mean /goal verify <command>?`,
    };
  }
  return null;
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

  const titleMatch = /^\/title(?:\s+(.*))?$/u.exec(trimmed);
  if (titleMatch !== null) {
    const title = titleMatch[1]?.trim();
    return title === undefined || title === ""
      ? { kind: "title" }
      : { kind: "title", title };
  }

  const goalMatch = /^\/goal(?:\s+(.*))?$/u.exec(trimmed);
  if (goalMatch !== null) {
    const goalCommand = parseGoalCommandArgs(goalMatch[1]);
    return goalCommand.kind === "invalid"
      ? { ...goalCommand, scope: "goal" }
      : goalCommand;
  }

  const tasksMatch = /^\/tasks(?:\s+(.*))?$/u.exec(trimmed);
  if (tasksMatch !== null) {
    const extraArgs = tasksMatch[1]?.trim();
    if (extraArgs !== undefined && extraArgs !== "") {
      return {
        kind: "invalid",
        message: "Error: /tasks does not accept arguments.",
      };
    }
    return { kind: "tasks" };
  }

  const diffMatch = /^\/diff(?:\s+(.*))?$/u.exec(trimmed);
  if (diffMatch !== null) {
    const extraArgs = diffMatch[1]?.trim();
    if (extraArgs !== undefined && extraArgs !== "") {
      return {
        kind: "invalid",
        message: "Error: /diff does not accept arguments.",
      };
    }
    return { kind: "diff" };
  }

  const approvalsMatch = /^\/approvals(?:\s+(.*))?$/u.exec(trimmed);
  if (approvalsMatch !== null) {
    return parseApprovalsCommandArgs(approvalsMatch[1]);
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
    if (extraArgs === undefined || extraArgs === "") return { kind: "skill" };
    const separator = extraArgs.search(/\s/u);
    return separator === -1
      ? { kind: "skill", lookup: extraArgs }
      : {
          kind: "skill",
          lookup: extraArgs.slice(0, separator),
          arguments: extraArgs.slice(separator).trim(),
        };
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
  return `Error: ${command} requires a saved session. Start without --ephemeral, or use --session or --resume.\n`;
}

function formatInteractiveTitleText(title: string): string {
  return sanitizeStatusLineText(
    redactTextForPersistence(title).replace(/\s+/gu, " ").trim(),
  );
}

function formatInteractiveGoalText(text: string): string {
  return sanitizeStatusLineText(redactTextForPersistence(text).trim());
}

export function formatInteractiveTitle(title: string | undefined): string {
  return `Session title: ${
    title === undefined ? "(not set)" : formatInteractiveTitleText(title)
  }\n`;
}

export function formatInteractiveTitleSet(title: string): string {
  return `Session title set to: ${formatInteractiveTitleText(title)}\n`;
}

export function formatTitleRequiresSavedSession(): string {
  return "Error: /title requires a saved session. Start without --ephemeral, or use --session or --resume.\n";
}

export function formatInteractiveGoal(goal: SessionGoal | undefined): string {
  const evidence = formatSessionGoalCompletionEvidenceSummary(goal);
  const outcome = formatSessionGoalRuntimeOutcomeSummary(goal);
  return [
    `Session goal: ${formatInteractiveGoalText(formatSessionGoalSummary(goal, { includeCompletionEvidence: false }))}`,
    ...(outcome === null
      ? []
      : [`Session goal outcome: ${formatInteractiveGoalText(outcome)}`]),
    ...(evidence === null
      ? []
      : [`Session goal evidence: ${formatInteractiveGoalText(evidence)}`]),
    "",
  ].join("\n");
}

export function formatInteractiveGoalBudget(
  goal: SessionGoal | undefined,
): string {
  if (goal === undefined) {
    return formatInteractiveGoal(goal);
  }
  return `Session goal: ${formatInteractiveGoalText(
    formatSessionGoalSummary(goal, {
      includeCompletionEvidence: false,
      includeAccounting: true,
    }),
  )}\n`;
}

export function formatInteractiveGoalSet(goal: SessionGoal): string {
  return `Goal set: ${formatInteractiveGoalText(goal.status)}\n`;
}

export function formatInteractiveGoalCompleted(goal: SessionGoal): string {
  return `Goal completed: ${formatInteractiveGoalText(goal.objective)}\n`;
}

export function formatInteractiveGoalPaused(goal: SessionGoal): string {
  return `Goal paused: ${formatInteractiveGoalText(goal.objective)}\n`;
}

export function formatInteractiveGoalResumed(goal: SessionGoal): string {
  return `Goal resumed: ${formatInteractiveGoalText(goal.objective)}\n`;
}

export function formatInteractiveGoalBudgetUpdated(goal: SessionGoal): string {
  return `Goal budget updated.\n${formatInteractiveGoalBudget(goal)}`;
}

export function formatInteractiveGoalBudgetCleared(goal: SessionGoal): string {
  return `Goal budget cleared.\n${formatInteractiveGoalBudget(goal)}`;
}

export function formatInteractiveGoalVerificationSet(
  goal: SessionGoal & {
    readonly criterionKind: "command";
    readonly completionCriterion: string;
  },
  options: { readonly bashToolVisible: boolean },
): string {
  const setMessage = `Goal verification command set: ${formatInteractiveGoalText(
    goal.completionCriterion,
  )}\n`;
  const timeoutMessage =
    goal.verificationTimeoutMs === undefined
      ? ""
      : `Goal verification timeout: ${formatSessionGoalDuration(goal.verificationTimeoutMs)}\n`;
  if (options.bashToolVisible) {
    return `${setMessage}${timeoutMessage}`;
  }
  return `${setMessage}${timeoutMessage}Note: bash is disabled in this run, so the agent cannot run this verification command. Resume with --bash-policy ask or --bash-policy trusted, or use /goal complete after checking it manually.\n`;
}

export function formatInteractiveGoalCriterionSet(
  goal: SessionGoal & {
    readonly criterionKind: SessionGoalCriterionKind;
    readonly completionCriterion: string;
  },
): string {
  return `Goal ${goal.criterionKind} criterion set: ${formatInteractiveGoalText(goal.completionCriterion)}\n`;
}

export function formatInteractiveGoalCleared(): string {
  return "Goal cleared.\n";
}

export function formatGoalRequiresSavedSession(): string {
  return "Error: /goal requires a saved session. Start without --ephemeral, or use --session or --resume.\n";
}
