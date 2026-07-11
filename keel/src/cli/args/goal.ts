import {
  normalizeSessionGoalCompletionCommand,
  normalizeSessionGoalObjective,
  SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  type SessionGoalBudget,
} from "../../core/session-goal.ts";
import { bashModeFromPolicy } from "../../permissions/bash.ts";
import {
  parseGoalDuration,
  parseGoalPositiveIntegerOption,
  parseGoalVerificationTimeout,
} from "../goal-options.ts";
import {
  type ParseResult,
  parseBashPolicy,
  parseError,
  parseMaxCost,
  parseOk,
  parseProviderId,
  requireOptionValue,
  requireSeparatedOptionValue,
} from "./shared.ts";
import type { GoalCliArgs } from "./types.ts";

const GOAL_OPTIONS = [
  "--objective",
  "--verify",
  "--timeout",
  "--turns",
  "--tokens",
  "--time",
  "--allow-bash",
  "--bash-policy",
  "--provider",
  "--model",
  "--skill",
  "--max-cost",
  "--report",
  "--session",
];

const GOAL_RESUME_OPTIONS = [
  "--last",
  "--turns",
  "--tokens",
  "--time",
  "--allow-bash",
  "--bash-policy",
  "--provider",
  "--model",
  "--skill",
  "--max-cost",
  "--report",
];

function separatedValue(
  option: string,
  value: string | undefined,
): ParseResult<string> {
  return requireSeparatedOptionValue(option, value, GOAL_OPTIONS);
}

function duplicateOption(option: string): ParseResult<never> {
  return parseError(`Error: duplicate goal option "${option}".`);
}

export function parseGoalArgs(
  args: readonly string[],
): ParseResult<GoalCliArgs> {
  if (args[0] === "resume") {
    return parseGoalResumeArgs(args.slice(1));
  }
  return parseGoalLaunchArgs(args);
}

function parseGoalLaunchArgs(
  args: readonly string[],
): ParseResult<GoalCliArgs> {
  let objective: string | undefined;
  let verificationCommand: string | undefined;
  let verificationTimeoutMs: number | undefined;
  const budget: {
    turns?: number;
    tokens?: number;
    activeTimeMs?: number;
  } = {};
  let bashMode: GoalCliArgs["bashMode"] = "disabled";
  let providerId: GoalCliArgs["providerId"] | undefined;
  let model: string | undefined;
  let skillName: string | undefined;
  let maxCostUsd: number | undefined;
  let reportFile: string | undefined;
  let sessionId: string | undefined;
  const seen = new Set<string>();

  const iterator = args[Symbol.iterator]();
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const arg = next.value;
    const equalsIndex = arg.indexOf("=");
    const option = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    if (!GOAL_OPTIONS.includes(option)) {
      return parseError(`Error: unknown goal option "${arg}".`);
    }
    if (seen.has(option)) return duplicateOption(option);
    seen.add(option);

    if (option === "--allow-bash") {
      if (inlineValue !== undefined) {
        return parseError("Error: --allow-bash does not accept a value.");
      }
      if (seen.has("--bash-policy")) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      bashMode = "trusted";
      continue;
    }

    const parsedValue =
      inlineValue === undefined
        ? separatedValue(option, iterator.next().value)
        : requireOptionValue(option, inlineValue);
    if (!parsedValue.ok) return parsedValue;
    const value = parsedValue.value;

    if (option === "--objective") {
      objective = normalizeSessionGoalObjective(value);
      continue;
    }
    if (option === "--verify") {
      verificationCommand = normalizeSessionGoalCompletionCommand(value);
      continue;
    }
    if (option === "--timeout") {
      const parsed = parseGoalVerificationTimeout(value);
      if (!parsed.ok) return parsed;
      verificationTimeoutMs = parsed.value;
      continue;
    }
    if (option === "--turns" || option === "--tokens") {
      const parsed = parseGoalPositiveIntegerOption(option, value);
      if (!parsed.ok) return parsed;
      if (option === "--turns") budget.turns = parsed.value;
      else budget.tokens = parsed.value;
      continue;
    }
    if (option === "--time") {
      const parsed = parseGoalDuration(value);
      if (!parsed.ok) return parsed;
      budget.activeTimeMs = parsed.value;
      continue;
    }
    if (option === "--bash-policy") {
      if (seen.has("--allow-bash")) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      const parsed = parseBashPolicy(value);
      if (!parsed.ok) return parsed;
      bashMode = bashModeFromPolicy(parsed.value);
      continue;
    }
    if (option === "--provider") {
      const parsed = parseProviderId(value);
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
      continue;
    }
    if (option === "--model") {
      model = value;
      continue;
    }
    if (option === "--skill") {
      skillName = value;
      continue;
    }
    if (option === "--max-cost") {
      const parsed = parseMaxCost(value);
      if (!parsed.ok) return parsed;
      maxCostUsd = parsed.value;
      continue;
    }
    if (option === "--report") {
      reportFile = value;
      continue;
    }
    sessionId = value;
  }

  if (objective === undefined || objective === "") {
    return parseError("Error: goal requires --objective <objective>.");
  }
  if (verificationCommand === undefined || verificationCommand === "") {
    return parseError("Error: goal requires --verify <command>.");
  }
  if (objective.length > SESSION_GOAL_OBJECTIVE_MAX_LENGTH) {
    return parseError(
      `Error: /goal objective must be ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (
    verificationCommand.length > SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH
  ) {
    return parseError(
      `Error: /goal completion criterion must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer.`,
    );
  }

  return parseOk({
    command: "goal",
    mode: "launch",
    objective,
    verificationCommand,
    budget: budget satisfies SessionGoalBudget,
    bashMode,
    ...(verificationTimeoutMs !== undefined ? { verificationTimeoutMs } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(skillName !== undefined ? { skillName } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

function parseGoalResumeArgs(
  args: readonly string[],
): ParseResult<GoalCliArgs> {
  let sessionId: string | undefined;
  let useLast = false;
  let bashMode: GoalCliArgs["bashMode"] = "disabled";
  let providerId: GoalCliArgs["providerId"] | undefined;
  let model: string | undefined;
  let skillName: string | undefined;
  let maxCostUsd: number | undefined;
  let reportFile: string | undefined;
  const budget: {
    turns?: number;
    tokens?: number;
    activeTimeMs?: number;
  } = {};
  const seen = new Set<string>();

  const iterator = args[Symbol.iterator]();
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const arg = next.value;
    if (!arg.startsWith("--")) {
      if (sessionId !== undefined) {
        return parseError(`Error: unexpected goal resume argument "${arg}".`);
      }
      sessionId = arg;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const option = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    if (!GOAL_RESUME_OPTIONS.includes(option)) {
      return parseError(`Error: unknown goal resume option "${option}".`);
    }
    if (seen.has(option)) return duplicateOption(option);
    seen.add(option);

    if (option === "--last" || option === "--allow-bash") {
      if (inlineValue !== undefined) {
        return parseError(`Error: ${option} does not accept a value.`);
      }
      if (option === "--last") {
        useLast = true;
        continue;
      }
      if (seen.has("--bash-policy")) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      bashMode = "trusted";
      continue;
    }

    const parsedValue =
      inlineValue === undefined
        ? requireSeparatedOptionValue(
            option,
            iterator.next().value,
            GOAL_RESUME_OPTIONS,
          )
        : requireOptionValue(option, inlineValue);
    if (!parsedValue.ok) return parsedValue;
    const value = parsedValue.value;

    if (option === "--bash-policy") {
      if (seen.has("--allow-bash")) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      const parsed = parseBashPolicy(value);
      if (!parsed.ok) return parsed;
      bashMode = bashModeFromPolicy(parsed.value);
      continue;
    }
    if (option === "--turns" || option === "--tokens") {
      const parsed = parseGoalPositiveIntegerOption(option, value);
      if (!parsed.ok) return parsed;
      if (option === "--turns") budget.turns = parsed.value;
      else budget.tokens = parsed.value;
      continue;
    }
    if (option === "--time") {
      const parsed = parseGoalDuration(value);
      if (!parsed.ok) return parsed;
      budget.activeTimeMs = parsed.value;
      continue;
    }
    if (option === "--provider") {
      const parsed = parseProviderId(value);
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
      continue;
    }
    if (option === "--model") {
      model = value;
      continue;
    }
    if (option === "--skill") {
      skillName = value;
      continue;
    }
    if (option === "--max-cost") {
      const parsed = parseMaxCost(value);
      if (!parsed.ok) return parsed;
      maxCostUsd = parsed.value;
      continue;
    }
    reportFile = value;
  }

  if (sessionId !== undefined && useLast) {
    return parseError(
      "Error: goal resume accepts either <session-id> or --last, not both.",
    );
  }
  if (sessionId === undefined && !useLast) {
    return parseError("Error: goal resume requires <session-id> or --last.");
  }

  return parseOk({
    command: "goal",
    mode: "resume",
    resumeSession:
      sessionId === undefined ? { kind: "latest" } : { kind: "id", sessionId },
    budget: budget satisfies SessionGoalBudget,
    bashMode,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(skillName !== undefined ? { skillName } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
  });
}
