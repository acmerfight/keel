import { createInterface } from "node:readline/promises";
import type { CostReport } from "../agent/loop.ts";
import {
  clearReadVisibilityState,
  createReadVisibilityState,
  runAgentTurn,
} from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import { type CostModel, calculateRequestCostBatchUsd } from "../core/cost.ts";
import {
  type RecordLastBatchCheckpointOperation,
  recordLastTaskCheckpoint,
  restoreLastEditCheckpoint,
} from "../core/git.ts";
import type { Message, Usage } from "../llm/types.ts";
import { bashModeExposesTool } from "../permissions/bash.ts";
import { createProjectInstructionVisibilityState } from "../tools/scoped-project-instructions.ts";
import {
  formatInteractiveForkPicker,
  formatInteractiveSessionForkPoints,
} from "./fork-points.ts";
import { interactiveBashPermissionPolicy } from "./interactive-session/bash-approval.ts";
import {
  formatForkRequiresNamedSession,
  formatInteractiveCommandFailure,
  formatInteractiveHelp,
  parseInteractiveCommand,
  undoRestoredContextMessage,
} from "./interactive-session/commands.ts";
import {
  addUsage,
  buildSessionCostReport,
  EMPTY_USAGE,
  shouldTrackInteractiveCost,
} from "./interactive-session/cost.ts";
import { readForkPointPickerSelection } from "./interactive-session/fork-picker.ts";
import {
  createLineReader,
  type QueuedLine,
  queuedInputIds,
  trimQueuedLine,
} from "./interactive-session/line-reader.ts";
import { executeManualCompaction } from "./interactive-session/manual-compact.ts";
import type {
  EndEvent,
  EndEventWithCost,
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
  InteractiveSessionResult,
} from "./interactive-session/types.ts";

export type {
  InteractiveForkSessionRequest,
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
  InteractiveSessionResult,
  SessionPersistenceReason,
} from "./interactive-session/types.ts";

export async function runInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<InteractiveSessionResult> {
  const systemPrompt = buildAgentSystemPrompt({
    workspace: options.workspace,
    platform: options.platform,
    ...(options.projectInstructions !== undefined
      ? { projectInstructions: options.projectInstructions }
      : {}),
  });
  const messages: Message[] = [...(options.initialMessages ?? [])];
  let resolved: InteractiveResolvedProvider | null = null;
  const input = createInterface({
    input: options.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const lineReader = createLineReader(input, {
    ...(options.initialQueuedInputs !== undefined
      ? { initialQueuedInputs: options.initialQueuedInputs }
      : {}),
    ...(options.persistQueuedInput !== undefined
      ? { persistQueuedInput: options.persistQueuedInput }
      : {}),
  });
  const bashPermission = interactiveBashPermissionPolicy(
    options.cliArgs.bashMode,
    lineReader,
    options.writeStderr,
    {
      ...(options.initialBashApprovalGrants !== undefined
        ? { initialGrants: options.initialBashApprovalGrants }
        : {}),
      ...(options.persistBashApprovalGrant !== undefined
        ? { onGrant: options.persistBashApprovalGrant }
        : {}),
    },
  );
  let activeAbortController: AbortController | null = null;
  let reportProvider: InteractiveResolvedProvider | null = null;
  let sessionUsage = EMPTY_USAGE;
  let sessionTurns = 0;
  let sessionCostUsd = 0;
  let sessionStopReason = "completed";
  const restoreDrainedInput = (lines: readonly QueuedLine[]) => {
    if (lines.length === 0) {
      return;
    }
    lineReader.restoreLines(lines);
  };
  const consumeQueuedInputLines = (lines: readonly QueuedLine[]) => {
    const inputIds = queuedInputIds(lines);
    if (inputIds.length === 0) {
      return;
    }
    options.consumeQueuedInputs?.(inputIds);
  };
  const abortActiveTurn = () => {
    if (activeAbortController !== null) {
      if (activeAbortController.signal.aborted) {
        options.writeStdout("\n");
        options.forceExit(130);
      }
      activeAbortController.abort();
      return;
    }
    options.writeStdout("\n");
    options.setExitCode(130);
    input.close();
  };
  const currentSessionCostReport = (): CostReport =>
    buildSessionCostReport(sessionCostUsd, options.cliArgs.maxCostUsd);
  const currentReportEnd = (): EndEventWithCost | undefined => {
    if (sessionTurns === 0) {
      return undefined;
    }
    return {
      type: "end",
      usage: sessionUsage,
      turns: sessionTurns,
      stopReason: sessionStopReason,
      cost: currentSessionCostReport(),
    };
  };
  const remainingMaxCostUsd = (): number | undefined => {
    if (options.cliArgs.maxCostUsd === undefined) {
      return undefined;
    }
    return Math.max(0, options.cliArgs.maxCostUsd - sessionCostUsd);
  };
  const recordCompactionCost = (
    usage: Usage,
    costModel: CostModel,
  ): CostReport => {
    sessionUsage = addUsage(sessionUsage, usage);
    sessionCostUsd += calculateRequestCostBatchUsd(
      { requests: [{ usage }] },
      costModel,
    );
    return currentSessionCostReport();
  };
  const recordTurnEnd = (end: EndEvent): CostReport | undefined => {
    sessionUsage = addUsage(sessionUsage, end.usage);
    sessionTurns += end.turns;
    sessionStopReason = end.stopReason;
    if (end.cost === undefined) {
      return undefined;
    }
    sessionCostUsd += end.cost.spentUsd;
    return currentSessionCostReport();
  };
  const readVisibility = createReadVisibilityState();
  const projectInstructionVisibility = createProjectInstructionVisibilityState(
    options.workspace,
  );
  let postCompactionReadSequence = 0;

  options.onSigint(abortActiveTurn);
  try {
    for (;;) {
      const rawInput = await lineReader.readLine();
      if (rawInput === null) break;
      const rawLine = rawInput.line;
      const userMessage = rawLine.trim();
      if (userMessage === "") {
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      const interactiveCommand = parseInteractiveCommand(rawLine);
      if (interactiveCommand?.kind === "help") {
        options.writeStdout(formatInteractiveHelp());
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "invalid") {
        options.writeStderr(`${interactiveCommand.message}\n`);
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "undo") {
        const result = restoreLastEditCheckpoint(options.workspace);
        switch (result.status) {
          case "restored":
            options.writeStdout(`Restored ${result.restoredLabel}\n`);
            clearReadVisibilityState(readVisibility);
            projectInstructionVisibility.clear();
            messages.push({
              role: "user",
              content: undoRestoredContextMessage(result.restoredLabel),
            });
            if (options.persistSessionMessages !== undefined) {
              options.persistSessionMessages(
                messages,
                "turn",
                queuedInputIds([rawInput]),
              );
            } else {
              consumeQueuedInputLines([rawInput]);
            }
            break;
          case "none":
            options.writeStderr(`${result.message}\n`);
            consumeQueuedInputLines([rawInput]);
            break;
          case "blocked":
            options.writeStderr(`${result.message}\n`);
            consumeQueuedInputLines([rawInput]);
            break;
        }
        continue;
      }
      if (interactiveCommand?.kind === "fork-points") {
        if (options.listForkPoints === undefined) {
          options.writeStderr(formatForkRequiresNamedSession("/fork-points"));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        options.writeStdout(
          formatInteractiveSessionForkPoints(options.listForkPoints()),
        );
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "compact") {
        if (messages.length === 0 || resolved === null) {
          options.writeStderr(
            "Context compaction skipped: no conversation history to compact.\n",
          );
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        const compactAbortController = new AbortController();
        activeAbortController = compactAbortController;
        let compactCost: CostReport | undefined;
        try {
          compactCost = await executeManualCompaction({
            command: interactiveCommand,
            resolved,
            workspace: options.workspace,
            messages,
            systemPrompt,
            signal: compactAbortController.signal,
            readVisibility,
            projectInstructionVisibility,
            nextPostCompactionReadToolCallId: () =>
              `post_compaction_read_${postCompactionReadSequence++}`,
            options,
            recordCompactionCost,
          });
        } finally {
          activeAbortController = null;
        }
        if (!compactAbortController.signal.aborted) {
          options.persistSessionMessages?.(
            messages,
            "compaction",
            queuedInputIds([rawInput]),
          );
        }
        if (compactCost?.budgetExceeded === true) {
          sessionStopReason = "cost_budget";
          break;
        }
        continue;
      }
      if (interactiveCommand?.kind === "fork") {
        if (options.forkSession === undefined) {
          options.writeStderr(formatForkRequiresNamedSession("/fork"));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        if (interactiveCommand.pick === true) {
          if (options.listForkPoints === undefined) {
            options.writeStderr(formatForkRequiresNamedSession("/fork"));
            consumeQueuedInputLines([rawInput]);
            continue;
          }
          const forkPoints = options.listForkPoints();
          options.writeStdout(formatInteractiveForkPicker(forkPoints));
          const pickerResult = await readForkPointPickerSelection({
            maxChoice: forkPoints.points.length,
            lineReader,
            writeStdout: options.writeStdout,
            writeStderr: options.writeStderr,
          });
          const consumedLines = [rawInput, ...pickerResult.consumedLines];
          if (pickerResult.kind === "cancelled") {
            if (pickerResult.explicit) {
              options.writeStdout("Fork cancelled.\n");
            }
            consumeQueuedInputLines(consumedLines);
            continue;
          }
          try {
            const selectedPoint =
              pickerResult.selection.choice === 0
                ? undefined
                : forkPoints.points[pickerResult.selection.choice - 1];
            options.writeStdout(
              options.forkSession({
                targetSessionId: interactiveCommand.targetSessionId,
                ...(selectedPoint !== undefined
                  ? { beforeMessageId: selectedPoint.messageId }
                  : {}),
              }),
            );
          } catch (error) {
            options.writeStderr(formatInteractiveCommandFailure(error));
          }
          consumeQueuedInputLines(consumedLines);
          continue;
        }
        try {
          options.writeStdout(options.forkSession(interactiveCommand));
        } catch (error) {
          options.writeStderr(formatInteractiveCommandFailure(error));
        }
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      resolved ??= options.resolveProvider(userMessage);
      reportProvider ??= resolved;
      const messagesBeforeTurn = messages.slice();
      const checkpointOperations: RecordLastBatchCheckpointOperation[] = [];
      const turnStartSequence = lineReader.sequence();
      const drainedInjectedLines: QueuedLine[] = [];
      const deferredInputLines: QueuedLine[] = [];
      const turnAbortController = new AbortController();
      activeAbortController = turnAbortController;
      messages.push({ role: "user", content: userMessage });
      let deferRemainingInjectedInput = false;

      try {
        const remainingCostUsd = remainingMaxCostUsd();
        const stream = runAgentTurn({
          workspace: options.workspace,
          provider: resolved.provider,
          messages,
          systemPrompt,
          signal: turnAbortController.signal,
          allowBash: bashModeExposesTool(options.cliArgs.bashMode),
          stopPolicy: defaultStopPolicy(),
          ...(bashPermission !== undefined ? { bashPermission } : {}),
          ...(shouldTrackInteractiveCost(options.cliArgs)
            ? {
                costTracking: {
                  model: options.requireKnownCostModel(resolved),
                  ...(remainingCostUsd !== undefined
                    ? { maxCostUsd: remainingCostUsd }
                    : {}),
                },
              }
            : {}),
          ...(resolved.contextCompaction !== undefined
            ? { contextCompaction: resolved.contextCompaction }
            : {}),
          readVisibility,
          projectInstructionVisibility,
          recordCheckpointOperations: (operations) => {
            checkpointOperations.push(...operations);
          },
          drainInjectedUserMessages: () => {
            const queuedLines = lineReader
              .drainLinesAfter(turnStartSequence)
              .map(trimQueuedLine)
              .filter((queuedLine) => queuedLine.line !== "");
            if (deferRemainingInjectedInput) {
              deferredInputLines.push(...queuedLines);
              return [];
            }
            const firstCommandIndex = queuedLines.findIndex(
              (queuedLine) => parseInteractiveCommand(queuedLine.line) !== null,
            );
            const injectableLines =
              firstCommandIndex < 0
                ? queuedLines
                : queuedLines.slice(0, firstCommandIndex);
            drainedInjectedLines.push(...injectableLines);
            if (firstCommandIndex >= 0) {
              deferRemainingInjectedInput = true;
              deferredInputLines.push(...queuedLines.slice(firstCommandIndex));
            }
            return injectableLines.map((content) => ({
              role: "user",
              content: content.line,
            }));
          },
        });
        const finalEnd = await options.printAgentEvents(stream);
        if (turnAbortController.signal.aborted) {
          messages.splice(0, messages.length, ...messagesBeforeTurn);
          const restoredLines = [
            ...drainedInjectedLines,
            ...deferredInputLines,
          ];
          restoreDrainedInput(restoredLines);
          options.writeStdout("\n");
          continue;
        }
        restoreDrainedInput(deferredInputLines);
        options.persistSessionMessages?.(messages, "turn", [
          ...queuedInputIds([rawInput]),
          ...queuedInputIds(drainedInjectedLines),
        ]);
        options.writeStdout("\n");
        const cumulativeCost =
          finalEnd === undefined ? undefined : recordTurnEnd(finalEnd);
        if (
          options.cliArgs.maxCostUsd !== undefined &&
          cumulativeCost !== undefined
        ) {
          options.writeStderr(
            options.formatCostReport(
              cumulativeCost,
              options.cliArgs.maxCostUsd,
            ),
          );
        }
        if (cumulativeCost?.budgetExceeded === true) {
          break;
        }
      } catch (error) {
        if (!turnAbortController.signal.aborted) {
          throw error;
        }
        messages.splice(0, messages.length, ...messagesBeforeTurn);
        const restoredLines = [...drainedInjectedLines, ...deferredInputLines];
        restoreDrainedInput(restoredLines);
        options.writeStdout("\n");
      } finally {
        if (checkpointOperations.length > 1) {
          recordLastTaskCheckpoint({
            workspace: options.workspace,
            operations: checkpointOperations,
          });
        }
        activeAbortController = null;
      }
    }
  } finally {
    options.offSigint(abortActiveTurn);
    input.close();
  }
  const reportEnd = currentReportEnd();
  if (
    options.cliArgs.reportFile !== undefined &&
    reportProvider !== null &&
    reportEnd !== undefined
  ) {
    return {
      report: {
        provider: reportProvider.providerId,
        model: reportProvider.model,
        end: reportEnd,
      },
    };
  }
  return {};
}
