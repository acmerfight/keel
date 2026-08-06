import {
  assessSessionGoalResume,
  copySessionGoal,
  emptySessionGoalBudget,
  emptySessionGoalUsage,
  formatSessionGoalBudgetLimitReason,
  pauseActiveSessionGoal,
  type SessionGoal,
  type SessionGoalBudget,
  sessionGoalAccounting,
  sessionGoalCompletionContract,
  withSessionGoalRuntimeOutcome,
} from "../../core/session-goal.ts";

export type InteractiveGoalCommand =
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
      readonly criterion: string;
    }
  | {
      readonly kind: "goal";
      readonly action: "budget";
      readonly budget: SessionGoalBudget;
    };

export type InteractiveGoalCommandOutput =
  | { readonly kind: "show"; readonly goal: SessionGoal | undefined }
  | { readonly kind: "show_budget"; readonly goal: SessionGoal | undefined }
  | { readonly kind: "set"; readonly goal: SessionGoal }
  | { readonly kind: "paused"; readonly goal: SessionGoal }
  | { readonly kind: "resumed"; readonly goal: SessionGoal }
  | { readonly kind: "budget_updated"; readonly goal: SessionGoal }
  | { readonly kind: "budget_cleared"; readonly goal: SessionGoal }
  | { readonly kind: "completed"; readonly goal: SessionGoal }
  | {
      readonly kind: "verification_set";
      readonly goal: SessionGoal & {
        readonly completion: Extract<
          NonNullable<SessionGoal["completion"]>,
          { readonly kind: "command" }
        >;
      };
    }
  | {
      readonly kind: "criterion_set";
      readonly goal: SessionGoal & {
        readonly completion: Extract<
          NonNullable<SessionGoal["completion"]>,
          { readonly kind: "assertion" }
        >;
      };
    }
  | { readonly kind: "cleared" }
  | { readonly kind: "requires_saved_session" }
  | { readonly kind: "no_goal" }
  | { readonly kind: "pause_requires_active" }
  | { readonly kind: "resume_rejected"; readonly message: string }
  | { readonly kind: "completed_goal_budget" }
  | { readonly kind: "inactive_goal_criterion" }
  | { readonly kind: "persistence_failed"; readonly error: unknown };

type InteractiveGoalDrive = "retain" | "clear" | "activation" | "resumption";

export interface InteractiveGoalCommandResult {
  readonly drive: InteractiveGoalDrive;
  readonly consumeInput: boolean;
  readonly output: readonly InteractiveGoalCommandOutput[];
}

interface InteractiveGoalCommandOptions {
  readonly command: InteractiveGoalCommand;
  readonly goal: SessionGoal | undefined;
  readonly persistGoal?: (goal: SessionGoal | null) => SessionGoal | undefined;
}

function result(
  output:
    | InteractiveGoalCommandOutput
    | readonly InteractiveGoalCommandOutput[],
  options: {
    readonly drive?: InteractiveGoalDrive;
    readonly consumeInput?: boolean;
  } = {},
): InteractiveGoalCommandResult {
  return {
    drive: options.drive ?? "retain",
    consumeInput: options.consumeInput ?? false,
    output: Array.isArray(output) ? output : [output],
  };
}

function consumed(
  output: InteractiveGoalCommandOutput,
  drive: InteractiveGoalDrive = "retain",
): InteractiveGoalCommandResult {
  return result(output, { drive, consumeInput: true });
}

function preserveLatestSessionGoalRuntimeOutcome<Target extends SessionGoal>(
  source: SessionGoal,
  target: Target,
): Target {
  return source.latestRuntimeOutcome === undefined
    ? target
    : withSessionGoalRuntimeOutcome(target, source.latestRuntimeOutcome);
}

function persistenceFailure(error: unknown): InteractiveGoalCommandResult {
  return consumed({ kind: "persistence_failed", error }, "clear");
}

function requireGoal(
  goal: SessionGoal | undefined,
): SessionGoal | InteractiveGoalCommandResult {
  return goal ?? consumed({ kind: "no_goal" });
}

function isCommandResult(
  value: SessionGoal | InteractiveGoalCommandResult,
): value is InteractiveGoalCommandResult {
  return "drive" in value;
}

export function executeInteractiveGoalCommand(
  options: InteractiveGoalCommandOptions,
): InteractiveGoalCommandResult {
  const { command } = options;
  switch (command.action) {
    case "show":
      return consumed({ kind: "show", goal: options.goal });
    case "show_budget":
      return consumed({ kind: "show_budget", goal: options.goal });
    case "set":
    case "launch": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      try {
        const nextGoal: SessionGoal =
          command.action === "launch"
            ? command.criterion.kind === "command"
              ? {
                  objective: command.objective,
                  status: "active",
                  budget: command.budget,
                  usage: emptySessionGoalUsage(),
                  completion: {
                    kind: "command",
                    command: command.criterion.command,
                    ...(command.criterion.verificationTimeoutMs !== undefined
                      ? {
                          verificationTimeoutMs:
                            command.criterion.verificationTimeoutMs,
                        }
                      : {}),
                  },
                }
              : {
                  objective: command.objective,
                  status: "active",
                  budget: command.budget,
                  usage: emptySessionGoalUsage(),
                  completion: {
                    kind: "assertion",
                    assertion: command.criterion.assertion,
                  },
                }
            : {
                objective: command.objective,
                status: "active",
                budget: emptySessionGoalBudget(),
                usage: emptySessionGoalUsage(),
                completion: {
                  kind: "assertion",
                  assertion: command.objective,
                },
              };
        persistGoal(nextGoal);
        return result(
          command.action === "launch"
            ? [
                { kind: "set", goal: nextGoal },
                { kind: "show_budget", goal: nextGoal },
              ]
            : { kind: "set", goal: nextGoal },
          { drive: "activation" },
        );
      } catch (error) {
        return persistenceFailure(error);
      }
    }
    case "pause": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      const goal = requireGoal(options.goal);
      if (isCommandResult(goal)) {
        return goal;
      }
      if (goal.status !== "active") {
        return consumed({ kind: "pause_requires_active" });
      }
      try {
        const pausedGoal = pauseActiveSessionGoal(goal);
        persistGoal(pausedGoal);
        return result({ kind: "paused", goal: pausedGoal });
      } catch (error) {
        return persistenceFailure(error);
      }
    }
    case "resume": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      const assessment = assessSessionGoalResume(options.goal);
      if (assessment.kind !== "ready") {
        return consumed({
          kind: "resume_rejected",
          message: assessment.rejection,
        });
      }
      const goal = assessment.goal;
      try {
        const resumedGoal = preserveLatestSessionGoalRuntimeOutcome(goal, {
          objective: goal.objective,
          status: "active",
          ...sessionGoalAccounting(goal),
          ...sessionGoalCompletionContract(goal),
        });
        persistGoal(resumedGoal);
        return result(
          { kind: "resumed", goal: resumedGoal },
          { drive: "resumption" },
        );
      } catch (error) {
        return persistenceFailure(error);
      }
    }
    case "budget": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      const goal = requireGoal(options.goal);
      if (isCommandResult(goal)) {
        return goal;
      }
      if (goal.status === "completed") {
        return consumed({ kind: "completed_goal_budget" });
      }
      try {
        let budgetedGoal: SessionGoal = {
          ...copySessionGoal(goal),
          budget: {
            ...goal.budget,
            ...command.budget,
          },
        };
        if (budgetedGoal.status === "active") {
          const reason = formatSessionGoalBudgetLimitReason(budgetedGoal);
          if (reason !== null) {
            budgetedGoal = withSessionGoalRuntimeOutcome(
              {
                objective: budgetedGoal.objective,
                status: "budget_limited",
                statusReason: reason,
                ...sessionGoalAccounting(budgetedGoal),
                ...sessionGoalCompletionContract(budgetedGoal),
              },
              { kind: "limit_reached", reason },
            );
          }
        }
        persistGoal(budgetedGoal);
        return result({ kind: "budget_updated", goal: budgetedGoal });
      } catch (error) {
        return persistenceFailure(error);
      }
    }
    case "clear_budget": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      const goal = requireGoal(options.goal);
      if (isCommandResult(goal)) {
        return goal;
      }
      if (goal.status === "completed") {
        return consumed({ kind: "completed_goal_budget" });
      }
      try {
        const clearedGoal: SessionGoal = {
          ...copySessionGoal(goal),
          budget: emptySessionGoalBudget(),
        };
        persistGoal(clearedGoal);
        return result({ kind: "budget_cleared", goal: clearedGoal });
      } catch (error) {
        return persistenceFailure(error);
      }
    }
    case "complete": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      const goal = requireGoal(options.goal);
      if (isCommandResult(goal)) {
        return goal;
      }
      try {
        const completedGoal = withSessionGoalRuntimeOutcome(
          {
            objective: goal.objective,
            status: "completed",
            completionEvidence: { kind: "user_override" },
            ...sessionGoalAccounting(goal),
            ...sessionGoalCompletionContract(goal),
          },
          {
            kind: "completed",
            reason:
              "The user explicitly completed the goal with /goal complete.",
          },
        );
        persistGoal(completedGoal);
        return result({ kind: "completed", goal: completedGoal });
      } catch (error) {
        return persistenceFailure(error);
      }
    }
    case "verify": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      const goal = requireGoal(options.goal);
      if (isCommandResult(goal)) {
        return goal;
      }
      if (goal.status !== "active") {
        return consumed({ kind: "inactive_goal_criterion" });
      }
      try {
        const verifiedGoal = preserveLatestSessionGoalRuntimeOutcome(goal, {
          objective: goal.objective,
          status: "active",
          ...sessionGoalAccounting(goal),
          completion: {
            kind: "command",
            command: command.command,
            ...(command.verificationTimeoutMs !== undefined
              ? { verificationTimeoutMs: command.verificationTimeoutMs }
              : {}),
          },
        } satisfies SessionGoal & {
          readonly completion: {
            readonly kind: "command";
            readonly command: string;
            readonly verificationTimeoutMs?: number;
          };
        });
        persistGoal(verifiedGoal);
        return result({ kind: "verification_set", goal: verifiedGoal });
      } catch (error) {
        return persistenceFailure(error);
      }
    }
    case "criterion": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      const goal = requireGoal(options.goal);
      if (isCommandResult(goal)) {
        return goal;
      }
      if (goal.status !== "active") {
        return consumed({ kind: "inactive_goal_criterion" });
      }
      try {
        const goalWithCriterion = preserveLatestSessionGoalRuntimeOutcome(
          goal,
          {
            objective: goal.objective,
            status: "active",
            ...sessionGoalAccounting(goal),
            completion: {
              kind: "assertion",
              assertion: command.criterion,
            },
          } satisfies SessionGoal,
        );
        persistGoal(goalWithCriterion);
        return result({ kind: "criterion_set", goal: goalWithCriterion });
      } catch (error) {
        return persistenceFailure(error);
      }
    }
    case "clear": {
      const persistGoal = options.persistGoal;
      if (persistGoal === undefined) {
        return consumed({ kind: "requires_saved_session" });
      }
      try {
        persistGoal(null);
        return result({ kind: "cleared" });
      } catch (error) {
        return persistenceFailure(error);
      }
    }
  }
}
