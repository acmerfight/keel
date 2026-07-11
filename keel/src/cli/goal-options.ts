import { MAX_COMMAND_TIMEOUT_MS } from "../core/command-timeout.ts";
import { formatSessionGoalDuration } from "../core/session-goal.ts";

export type GoalOptionParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export function parseGoalPositiveIntegerOption(
  option: "--turns" | "--tokens",
  raw: string | undefined,
): GoalOptionParseResult<number> {
  if (raw === undefined || !/^[1-9][0-9]*$/u.test(raw)) {
    return {
      ok: false,
      message: `Error: ${option} must be a positive integer.`,
    };
  }
  const value = Number(raw);
  return Number.isSafeInteger(value)
    ? { ok: true, value }
    : {
        ok: false,
        message: `Error: ${option} must be a positive integer.`,
      };
}

export function parseGoalDuration(
  raw: string | undefined,
): GoalOptionParseResult<number> {
  const match = /^([1-9][0-9]*)(ms|s|m|h)$/u.exec(raw ?? "");
  if (match === null) {
    return {
      ok: false,
      message:
        "Error: --time must be a positive duration using ms, s, m, or h.",
    };
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const activeTimeMs = amount * multiplier;
  return Number.isSafeInteger(activeTimeMs)
    ? { ok: true, value: activeTimeMs }
    : {
        ok: false,
        message:
          "Error: --time must be a positive duration using ms, s, m, or h.",
      };
}

export function parseGoalVerificationTimeout(
  raw: string | undefined,
): GoalOptionParseResult<number> {
  const parsed = parseGoalDuration(raw);
  if (!parsed.ok || parsed.value > MAX_COMMAND_TIMEOUT_MS) {
    return {
      ok: false,
      message: `Error: --timeout must be a positive duration up to ${formatSessionGoalDuration(MAX_COMMAND_TIMEOUT_MS)} using ms, s, or m.`,
    };
  }
  return parsed;
}
