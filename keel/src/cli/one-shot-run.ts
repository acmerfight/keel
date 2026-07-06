import { createInterface } from "node:readline/promises";
import { runAgent } from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import { isAbortThrow } from "../core/error.ts";
import type { Message } from "../llm/types.ts";
import {
  type BashMode,
  type BashPermissionPolicy,
  bashModeExposesTool,
} from "../permissions/bash.ts";
import type { CliArgs } from "./args.ts";
import { createPromptedBashPermissionPolicy } from "./interactive-session/bash-approval.ts";
import { createLineReader } from "./interactive-session/line-reader.ts";
import { formatCostReport, printAgentEvents } from "./output.ts";
import {
  loadProjectInstructions,
  ProjectInstructionsError,
} from "./project-instructions.ts";
import {
  ProviderConfigError,
  requireKnownCostModel,
  resolveProvider,
} from "./provider-config.ts";
import { assertEndEventHasCost, writeRunReport } from "./report.ts";
import { createAgentEventReportRecorder } from "./report-events.ts";
import type { CliRuntime } from "./runtime.ts";
import { formatCliRuntimeError } from "./runtime-error.ts";
import {
  cleanupExpiredToolOutputArtifacts,
  createToolOutputArtifactStore,
  newToolOutputArtifactScope,
} from "./tool-output-artifacts.ts";
import { writeRunTranscript } from "./transcript.ts";
import { loadWorkflowSkill, WorkflowSkillError } from "./workflow-skills.ts";

type RunCliArgs = Extract<CliArgs, { readonly command: "run" }>;

function denyOneShotBashPermissionPolicy(): BashPermissionPolicy {
  return {
    review: () => ({
      type: "deny",
      message:
        "Shell command requires terminal approval; non-TTY one-shot runs cannot approve bash commands.",
    }),
  };
}

function oneShotBashPermissionPolicy(
  bashMode: BashMode,
  runtime: CliRuntime,
): {
  readonly policy?: BashPermissionPolicy;
  readonly close?: () => void;
} {
  if (bashMode !== "ask") {
    return {};
  }
  if (runtime.input.isTTY !== true) {
    return { policy: denyOneShotBashPermissionPolicy() };
  }

  const input = createInterface({
    input: runtime.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const lineReader = createLineReader(input, {});
  const policy = createPromptedBashPermissionPolicy(
    lineReader,
    runtime.writeStderr,
    { scopeLabel: "this run" },
  );
  return { policy, close: () => input.close() };
}

export async function runOneShotCli(
  cliArgs: RunCliArgs,
  runtime: CliRuntime,
  userMessage: string,
): Promise<number> {
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  let closeBashApprovalInput: (() => void) | undefined;
  try {
    const workspace = runtime.cwd();
    const projectInstructions = loadProjectInstructions(workspace);
    const workflowSkill =
      cliArgs.skillName === undefined
        ? undefined
        : loadWorkflowSkill(workspace, cliArgs.skillName);
    const resolved = resolveProvider(userMessage, runtime, {
      ...(cliArgs.providerId !== undefined
        ? { providerId: cliArgs.providerId }
        : {}),
      ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    });
    runtime.onSigint(abort);

    const startedAt = runtime.now();
    const bashPermission = oneShotBashPermissionPolicy(
      cliArgs.bashMode,
      runtime,
    );
    closeBashApprovalInput = bashPermission.close;
    await cleanupExpiredToolOutputArtifacts({ runtime });
    const toolOutputArtifacts = {
      store: createToolOutputArtifactStore({
        runtime,
        scope: newToolOutputArtifactScope("run"),
      }),
    };
    const systemPrompt = buildAgentSystemPrompt({
      workspace,
      platform: runtime.platform,
      ...(projectInstructions !== undefined ? { projectInstructions } : {}),
      ...(workflowSkill !== undefined ? { workflowSkill } : {}),
    });
    let transcriptMessages: readonly Message[] | undefined;
    const stream = runAgent({
      workspace,
      provider: resolved.provider,
      userMessage,
      systemPrompt,
      signal: abortController.signal,
      allowBash: bashModeExposesTool(cliArgs.bashMode),
      stopPolicy: defaultStopPolicy(),
      toolOutputArtifacts,
      ...(bashPermission.policy !== undefined
        ? { bashPermission: bashPermission.policy }
        : {}),
      ...(cliArgs.maxCostUsd !== undefined || cliArgs.reportFile !== undefined
        ? {
            costTracking: {
              model: requireKnownCostModel(resolved),
              ...(cliArgs.maxCostUsd !== undefined
                ? { maxCostUsd: cliArgs.maxCostUsd }
                : {}),
            },
          }
        : {}),
      ...(resolved.contextCompaction !== undefined
        ? { contextCompaction: resolved.contextCompaction }
        : {}),
      ...(cliArgs.transcriptFile !== undefined
        ? {
            onTranscriptReady: (messages) => {
              transcriptMessages = messages;
            },
          }
        : {}),
    });

    const reportRecorder = createAgentEventReportRecorder();
    const finalEnd = await printAgentEvents(stream, runtime, reportRecorder);
    runtime.writeStdout("\n");
    if (cliArgs.maxCostUsd !== undefined && finalEnd?.cost !== undefined) {
      runtime.writeStderr(formatCostReport(finalEnd.cost, cliArgs.maxCostUsd));
    }
    if (cliArgs.reportFile !== undefined && finalEnd !== undefined) {
      assertEndEventHasCost(finalEnd);
      writeRunReport(cliArgs.reportFile, {
        usageByModel: [
          {
            provider: resolved.provider.id,
            model: resolved.model,
            turns: finalEnd.turns,
            usage: finalEnd.usage,
            costUsd: finalEnd.cost.spentUsd,
          },
        ],
        end: finalEnd,
        durationMs: runtime.now() - startedAt,
        contextCompactions: reportRecorder.contextCompactions(),
      });
    }
    if (
      cliArgs.transcriptFile !== undefined &&
      transcriptMessages !== undefined
    ) {
      writeRunTranscript(cliArgs.transcriptFile, {
        provider: resolved.provider.id,
        model: resolved.model,
        systemPrompt,
        messages: transcriptMessages,
      });
    }
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof ProjectInstructionsError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof WorkflowSkillError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (isAbortThrow(error, abortController.signal)) {
      runtime.writeStdout("\n");
      return 130;
    }
    runtime.writeStderr(formatCliRuntimeError(error));
    return 1;
  } finally {
    closeBashApprovalInput?.();
    runtime.offSigint(abort);
  }
  return 0;
}
