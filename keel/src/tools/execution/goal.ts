import { z } from "zod";
import {
  copySessionGoal,
  formatSessionGoalBlockedProposalToolResult,
  formatSessionGoalBlockedToolResult,
  formatSessionGoalCompletedToolResult,
  normalizeSessionGoalCompletionCommand,
  normalizeSessionGoalStatusReason,
  type SessionGoal,
  type SessionGoalBlockedAuditCount,
  sessionGoalAccounting,
  sessionGoalCompletionContract,
  withSessionGoalRuntimeOutcome,
} from "../../core/session-goal.ts";
import type { BashRuntime } from "../../permissions/bash.ts";
import { executeBash } from "../bash.ts";
import type { ValidToolCall } from "../tool-call.ts";
import {
  type FailedToolExecution,
  NO_TOOL_EXECUTION_EFFECTS,
  sourceTruncation,
  type ToolExecution,
} from "./contracts.ts";

type UpdateGoalToolCall = Extract<
  ValidToolCall,
  { readonly tool: "update_goal" }
>;

interface AssertionGoalCompletionContract {
  readonly objective: string;
  readonly completionCriterion: string;
}

interface AssertionGoalCompletionEvaluation {
  readonly completed: boolean;
  readonly reason: string;
}

export interface GoalExecutionContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly bash: BashRuntime;
  readonly sessionGoal?: SessionGoal;
  readonly completionProposalHasFollowingToolCalls?: boolean;
  readonly evaluateAssertionGoalCompletion?: (
    goal: AssertionGoalCompletionContract,
  ) => Promise<AssertionGoalCompletionEvaluation>;
}

function rejectedGoalCompletion(
  sessionGoal: Extract<SessionGoal, { readonly status: "active" }>,
  content: string,
  reason: string,
): FailedToolExecution {
  return {
    content,
    ok: false,
    effects: [
      {
        kind: "session_goal",
        goal: withSessionGoalRuntimeOutcome(sessionGoal, {
          kind: "completion_rejected",
          reason,
        }),
      },
    ],
  };
}

function commandVerificationFailureContent(
  command: string,
  exitCode: number | null,
  verificationOutput: string,
): string {
  return `Tool failed: update_goal failed: completion command ${JSON.stringify(command)} exited with code ${exitCode ?? "unknown"} at the completion boundary.\nVerification output:\n${verificationOutput}\nRecovery: Fix the failing verification, then propose completion again.`;
}

export async function executeUpdateGoalTool(
  {
    workspace,
    bash,
    signal,
    sessionGoal,
    completionProposalHasFollowingToolCalls,
    evaluateAssertionGoalCompletion,
  }: GoalExecutionContext,
  toolCall: UpdateGoalToolCall,
): Promise<ToolExecution> {
  if (sessionGoal?.status !== "active") {
    return {
      content:
        "Tool failed: update_goal failed: no active session goal is set.\nRecovery: Continue without updating the goal, or ask the user to set a saved session goal first.",
      ok: false,
      effects: NO_TOOL_EXECUTION_EFFECTS,
    };
  }
  if (toolCall.status === "blocked") {
    const blockedReason = normalizeSessionGoalStatusReason(
      z.string().parse(toolCall.reason),
    );
    const priorAudit = sessionGoal.blockedAudit;
    if (priorAudit?.consecutiveCount === 2) {
      const blockedGoalWithoutOutcome: SessionGoal = {
        objective: sessionGoal.objective,
        status: "blocked",
        statusReason: blockedReason,
        ...sessionGoalAccounting(sessionGoal),
        ...sessionGoalCompletionContract(sessionGoal),
      };
      const blockedGoal = withSessionGoalRuntimeOutcome(
        blockedGoalWithoutOutcome,
        { kind: "blocked", reason: blockedReason },
      );
      return {
        content: formatSessionGoalBlockedToolResult(blockedGoal),
        ok: true,
        effects: [{ kind: "session_goal", goal: copySessionGoal(blockedGoal) }],
      };
    }
    const consecutiveCount: SessionGoalBlockedAuditCount =
      priorAudit?.consecutiveCount === 1 ? 2 : 1;
    const blockedProposalGoalWithoutOutcome = {
      objective: sessionGoal.objective,
      status: "active",
      ...sessionGoalAccounting(sessionGoal),
      blockedAudit: {
        consecutiveCount,
        reason: blockedReason,
      },
      ...sessionGoalCompletionContract(sessionGoal),
    } satisfies Extract<SessionGoal, { readonly status: "active" }> & {
      readonly blockedAudit: NonNullable<
        Extract<SessionGoal, { readonly status: "active" }>["blockedAudit"]
      >;
    };
    const blockedProposalGoal = withSessionGoalRuntimeOutcome(
      blockedProposalGoalWithoutOutcome,
      {
        kind: "blocker_audit",
        reason: `Blocked audit ${consecutiveCount}/3 recorded: ${blockedReason}`,
      },
    );
    return {
      content: formatSessionGoalBlockedProposalToolResult(blockedProposalGoal),
      ok: true,
      effects: [
        { kind: "session_goal", goal: copySessionGoal(blockedProposalGoal) },
      ],
    };
  }
  if (sessionGoal.completion === undefined) {
    return rejectedGoalCompletion(
      sessionGoal,
      "Tool failed: update_goal failed: no completion criterion is set for the active session goal.\nRecovery: Ask the user to add one with /goal verify <command> or /goal done-when <criterion>, continue working, or ask the user to use /goal complete for an explicit override.",
      "Completion was rejected because the active goal has no completion criterion.",
    );
  }
  if (completionProposalHasFollowingToolCalls === true) {
    return rejectedGoalCompletion(
      sessionGoal,
      "Tool failed: update_goal failed: completed must be the final tool call in an agent turn.\nRecovery: Finish the remaining actions, inspect their results, then propose completion in a later turn.",
      "Completion was rejected because update_goal(completed) was not the final tool call in its agent turn.",
    );
  }
  if (sessionGoal.completion.kind === "assertion") {
    if (evaluateAssertionGoalCompletion === undefined) {
      return rejectedGoalCompletion(
        sessionGoal,
        "Tool failed: update_goal failed: assertion completion evaluator is unavailable.\nRecovery: Continue gathering evidence, ask the user to use /goal complete for an explicit override, or retry in an agent session that supports assertion evaluation.",
        "Completion was rejected because the assertion evaluator was unavailable.",
      );
    }
    const evaluation = await evaluateAssertionGoalCompletion({
      objective: sessionGoal.objective,
      completionCriterion: sessionGoal.completion.assertion,
    });
    if (!evaluation.completed) {
      return rejectedGoalCompletion(
        sessionGoal,
        "Tool failed: update_goal failed: assertion completion evaluator rejected completion.\n" +
          `Reason: ${evaluation.reason}\n` +
          "Recovery: Continue gathering or surfacing evidence that satisfies the assertion criterion, then call update_goal again only after the evidence is visible.",
        evaluation.reason,
      );
    }
    const completedGoalWithoutOutcome: SessionGoal = {
      objective: sessionGoal.objective,
      status: "completed",
      ...sessionGoalAccounting(sessionGoal),
      ...sessionGoalCompletionContract(sessionGoal),
      completionEvidence: {
        kind: "assertion_evaluator",
        reason: evaluation.reason,
      },
    };
    const completedGoal = withSessionGoalRuntimeOutcome(
      completedGoalWithoutOutcome,
      {
        kind: "completed",
        reason: `Assertion evaluator approved completion: ${evaluation.reason}`,
      },
    );
    return {
      content: formatSessionGoalCompletedToolResult(completedGoal),
      ok: true,
      effects: [{ kind: "session_goal", goal: copySessionGoal(completedGoal) }],
    };
  }
  const expectedCommand = normalizeSessionGoalCompletionCommand(
    sessionGoal.completion.command,
  );
  if (bash.kind === "disabled") {
    return rejectedGoalCompletion(
      sessionGoal,
      `Tool failed: update_goal failed: Runtime cannot run command completion criterion ${JSON.stringify(expectedCommand)} because Bash is unavailable in this capability context.\nRecovery: Ask the parent to run the command or use /goal complete after checking it manually.`,
      `Completion was rejected because Runtime could not run command criterion ${JSON.stringify(expectedCommand)} while Bash was disabled.`,
    );
  }
  if (bash.kind === "reviewed") {
    const decision = await bash.permission.review({
      command: expectedCommand,
      cwd: workspace,
      signal,
    });
    if (decision.type === "deny") {
      return rejectedGoalCompletion(
        sessionGoal,
        `Tool failed: update_goal failed: command completion verification was denied: ${decision.message}\nRecovery: Ask the user for permission or use /goal complete after checking it manually.`,
        `Completion was rejected because permission to run command criterion ${JSON.stringify(expectedCommand)} was denied.`,
      );
    }
  }
  const verification = await executeBash(workspace, expectedCommand, {
    signal,
    ...(sessionGoal.completion.verificationTimeoutMs !== undefined
      ? { timeoutMs: sessionGoal.completion.verificationTimeoutMs }
      : {}),
  });
  if (verification.exitCode !== 0) {
    const rejection = rejectedGoalCompletion(
      sessionGoal,
      commandVerificationFailureContent(
        expectedCommand,
        verification.exitCode,
        verification.content,
      ),
      `Completion was rejected because command criterion ${JSON.stringify(expectedCommand)} exited with code ${verification.exitCode ?? "unknown"} at the completion boundary.`,
    );
    const truncation = sourceTruncation(verification);
    return {
      ...rejection,
      ...truncation,
      ...(truncation.artifact !== undefined
        ? {
            artifact: {
              content: commandVerificationFailureContent(
                expectedCommand,
                verification.exitCode,
                truncation.artifact.content,
              ),
              sourceTruncated: truncation.artifact.sourceTruncated,
            },
          }
        : {}),
    };
  }
  const completedGoalWithoutOutcome: SessionGoal = {
    objective: sessionGoal.objective,
    status: "completed",
    ...sessionGoalAccounting(sessionGoal),
    ...sessionGoalCompletionContract(sessionGoal),
    completionEvidence: {
      kind: "command",
      command: expectedCommand,
      cwd: workspace,
      exitCode: 0,
      freshness: "at_completion",
    },
  };
  const completedGoal = withSessionGoalRuntimeOutcome(
    completedGoalWithoutOutcome,
    {
      kind: "completed",
      reason: `Completion command ${JSON.stringify(expectedCommand)} exited 0 at the completion boundary.`,
    },
  );
  return {
    content: formatSessionGoalCompletedToolResult(completedGoal),
    ok: true,
    effects: [{ kind: "session_goal", goal: copySessionGoal(completedGoal) }],
  };
}
