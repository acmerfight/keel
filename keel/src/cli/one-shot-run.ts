import { createInterface } from "node:readline/promises";
import { runAgent } from "../agent/loop.ts";
import {
  appendProjectMemoryToSystemPrompt,
  appendWorkflowSkillsToSystemPrompt,
  buildAgentSystemPrompt,
} from "../agent/prompt.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import { isAbortThrow } from "../core/error.ts";
import { modelMetadataMaxOutputTokens } from "../core/model-metadata.ts";
import type { Message } from "../llm/types.ts";
import {
  type BashMode,
  type BashPermissionDecision,
  type BashPermissionPolicy,
  bashModeExposesTool,
  createSessionBashPermissionPolicy,
} from "../permissions/bash.ts";
import {
  exposeSkillCatalog,
  formatSkillCatalogDegradation,
} from "../skills/catalog.ts";
import { parseExplicitSkillInvocation } from "../skills/explicit.ts";
import {
  createSkillActivation,
  workflowSkillFromActivation,
} from "../skills/lifecycle.ts";
import { explicitSkillActivationRecord } from "../skills/model.ts";
import { repositoryWorkflowSkillRootPaths } from "../skills/project.ts";
import { createAgentProjectMemory } from "./agent-project-memory.ts";
import type { CliArgs } from "./args.ts";
import {
  BashProjectApprovalsError,
  bashApprovalProjectRoot,
  listBashProjectApprovalGrants,
  saveBashProjectApprovalGrant,
} from "./bash-project-approvals.ts";
import { createPromptedBashPermissionPolicy } from "./interactive-session/bash-approval.ts";
import { createLineReader } from "./interactive-session/line-reader.ts";
import {
  formatCostReport,
  formatUndoCheckpointWarning,
  printAgentEvents,
} from "./output.ts";
import {
  loadProjectInstructions,
  ProjectInstructionsError,
} from "./project-instructions.ts";
import {
  loadRenderedProjectMemory,
  ProjectMemoryError,
} from "./project-memory.ts";
import {
  ProviderConfigError,
  requireKnownCostModel,
  resolveProvider,
} from "./provider-config.ts";
import {
  assertEndEventHasCost,
  projectMemoryReportEntry,
  type RunReportMemory,
  type RunReportMemoryEntry,
  reportActiveSkills,
  writeRunReport,
} from "./report.ts";
import { createAgentEventReportRecorder } from "./report-events.ts";
import type { CliRuntime } from "./runtime.ts";
import { formatCliRuntimeError } from "./runtime-error.ts";
import {
  resolveSkillRuntimePolicy,
  SkillUserConfigError,
  skillPolicyReport,
} from "./skill-user-config.ts";
import {
  cleanupExpiredToolOutputArtifacts,
  createToolOutputArtifactStore,
  newToolOutputArtifactScope,
} from "./tool-output-artifacts.ts";
import { writeRunTranscript } from "./transcript.ts";
import {
  disabledWorkflowSkillWorkspacePaths,
  discoverWorkflowSkillCatalog,
  filterWorkflowSkillCatalog,
  formatWorkflowSkillListWarnings,
  WorkflowSkillError,
} from "./workflow-skills.ts";

type RunCliArgs = Extract<CliArgs, { readonly command: "run" }>;

function denyOneShotBashPermissionDecision(): BashPermissionDecision {
  return {
    type: "deny",
    message:
      "Shell command requires terminal approval; non-TTY one-shot runs cannot approve bash commands.",
  };
}

function oneShotBashPermissionPolicy(
  bashMode: BashMode,
  runtime: CliRuntime,
  workspace: string,
): {
  readonly policy?: BashPermissionPolicy;
  readonly close?: () => void;
} {
  if (bashMode !== "ask") {
    return {};
  }
  const projectRoot = bashApprovalProjectRoot(workspace);
  const initialProjectGrants = listBashProjectApprovalGrants(
    runtime,
    projectRoot,
  );
  if (runtime.input.isTTY !== true) {
    return {
      policy: createSessionBashPermissionPolicy({
        projectRoot,
        initialProjectGrants,
        prompt: () => denyOneShotBashPermissionDecision(),
      }),
    };
  }

  const input = createInterface({
    input: runtime.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const lineReader = createLineReader(input, {});
  const policy = createPromptedBashPermissionPolicy(
    lineReader,
    runtime.writeStderr,
    {
      scopeLabel: "this run",
      projectRoot,
      initialProjectGrants,
      onProjectGrant: (grant) => {
        saveBashProjectApprovalGrant(runtime, grant);
      },
    },
  );
  return { policy, close: () => input.close() };
}

export async function runOneShotCli(
  cliArgs: RunCliArgs,
  runtime: CliRuntime,
  originalUserMessage: string,
): Promise<number> {
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  let closeBashApprovalInput: (() => void) | undefined;
  try {
    const workspace = runtime.cwd();
    const projectInstructions = loadProjectInstructions(workspace);
    const skillPolicy = resolveSkillRuntimePolicy(
      runtime,
      cliArgs.skillsEnabled,
    );
    const invocation = parseExplicitSkillInvocation(originalUserMessage);
    if (
      !skillPolicy.enabled &&
      (invocation !== null || (cliArgs.skillNames?.length ?? 0) > 0)
    ) {
      throw new WorkflowSkillError(skillPolicy.unavailableReason);
    }
    const userMessage =
      invocation === null || invocation.arguments !== ""
        ? (invocation?.arguments ?? originalUserMessage)
        : "Apply the explicitly selected workflow skill.";
    const rawCatalog = skillPolicy.enabled
      ? discoverWorkflowSkillCatalog(runtime, workspace)
      : undefined;
    const catalog =
      rawCatalog === undefined
        ? undefined
        : filterWorkflowSkillCatalog(
            rawCatalog,
            skillPolicy.disabledPackageIds,
          );
    const hiddenWorkspacePaths =
      rawCatalog === undefined
        ? repositoryWorkflowSkillRootPaths(workspace)
        : disabledWorkflowSkillWorkspacePaths(
            workspace,
            rawCatalog,
            skillPolicy.disabledPackageIds,
          );
    const explicitLookups = [
      ...(cliArgs.skillNames ?? []),
      ...(invocation === null ? [] : [invocation.lookup]),
    ];
    const workflowSkills = explicitLookups
      .map((lookup) => catalog?.load(lookup))
      .filter((skill) => skill !== undefined)
      .filter(
        (skill, index, skills) =>
          skills.findIndex(
            (candidate) => candidate.packageId === skill.packageId,
          ) === index,
      );
    if (catalog !== undefined) {
      runtime.writeStderr(formatWorkflowSkillListWarnings(catalog.warnings));
    }
    const resolved = resolveProvider(userMessage, runtime, {
      ...(cliArgs.providerId !== undefined
        ? { providerId: cliArgs.providerId }
        : {}),
      ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    });
    const catalogExposure = exposeSkillCatalog({
      skills: (catalog?.implicitSkills ?? []).filter(
        (descriptor) =>
          !workflowSkills.some(
            (active) => active.packageId === descriptor.packageId,
          ),
      ),
      request: userMessage,
      modelMetadata: resolved.modelMetadata,
    });
    runtime.writeStderr(formatSkillCatalogDegradation(catalogExposure));
    const skillActivation =
      catalog !== undefined && catalog.skills.length > 0
        ? createSkillActivation(catalog)
        : undefined;
    skillActivation?.expose(catalogExposure.skills);
    skillActivation?.registerExplicit(workflowSkills);
    skillActivation?.beginTurn();
    runtime.onSigint(abort);

    const startedAt = runtime.now();
    const bashPermission = oneShotBashPermissionPolicy(
      cliArgs.bashMode,
      runtime,
      workspace,
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
      ...(catalogExposure.skills.length > 0
        ? { skillCatalog: catalogExposure.skills }
        : {}),
    });
    const exposedMemoryEntries = new Map<string, RunReportMemoryEntry>();
    let exposedMemoryBytes = 0;
    let exposedMemoryTokens = 0;
    let transcriptMemoryPrompt = "";
    let memoryPrompt: (() => string) | undefined;
    let memoryReport: () => RunReportMemory;
    const agentMemory = createAgentProjectMemory({ runtime, workspace });
    if (cliArgs.memoryEnabled) {
      let loadedMemory = loadRenderedProjectMemory(runtime, workspace);
      memoryPrompt = () => {
        loadedMemory = loadRenderedProjectMemory(runtime, workspace);
        for (const entry of loadedMemory.entries) {
          exposedMemoryEntries.set(entry.id, projectMemoryReportEntry(entry));
        }
        exposedMemoryBytes = Math.max(
          exposedMemoryBytes,
          loadedMemory.renderedBytes,
        );
        exposedMemoryTokens = Math.max(
          exposedMemoryTokens,
          loadedMemory.estimatedTokens,
        );
        if (loadedMemory.prompt !== "")
          transcriptMemoryPrompt = loadedMemory.prompt;
        return loadedMemory.prompt;
      };
      memoryReport = () => ({
        enabled: true,
        scope: loadedMemory.scope,
        loadedIds: [...exposedMemoryEntries.keys()],
        loadedEntries: [...exposedMemoryEntries.values()],
        renderedBytes: exposedMemoryBytes,
        estimatedTokens: exposedMemoryTokens,
        operations: agentMemory.operations(),
      });
    } else {
      memoryReport = () => ({
        enabled: false,
        scope: null,
        loadedIds: [],
        loadedEntries: [],
        renderedBytes: 0,
        estimatedTokens: 0,
        operations: [],
      });
    }
    const modelMaxOutputTokens = modelMetadataMaxOutputTokens(
      resolved.modelMetadata,
    );
    const trackedCostModel =
      cliArgs.maxCostUsd !== undefined || cliArgs.reportFile !== undefined
        ? requireKnownCostModel(resolved)
        : undefined;
    const reportRecorder = createAgentEventReportRecorder();
    reportRecorder.beginTask("user_prompt");
    reportRecorder.beginAgentRun("user_prompt");
    let transcriptMessages: readonly Message[] | undefined;
    const stream = runAgent({
      workspace,
      provider: resolved.provider,
      userMessage,
      systemPrompt,
      ...(memoryPrompt !== undefined ? { memoryPrompt } : {}),
      ...(cliArgs.memoryEnabled
        ? { memoryMutation: agentMemory.capability }
        : {}),
      signal: abortController.signal,
      allowBash: bashModeExposesTool(cliArgs.bashMode),
      ...(hiddenWorkspacePaths.length > 0 ? { hiddenWorkspacePaths } : {}),
      ...(skillActivation !== undefined ? { skillActivation } : {}),
      stopPolicy: defaultStopPolicy(),
      toolOutputArtifacts,
      ...(bashPermission.policy !== undefined
        ? { bashPermission: bashPermission.policy }
        : {}),
      ...(trackedCostModel !== undefined
        ? {
            costTracking: {
              model: trackedCostModel,
              ...(modelMaxOutputTokens !== undefined
                ? { modelMaxOutputTokens }
                : {}),
              ...(cliArgs.maxCostUsd !== undefined
                ? { maxCostUsd: cliArgs.maxCostUsd }
                : {}),
            },
          }
        : {}),
      ...(cliArgs.reportFile !== undefined && trackedCostModel !== undefined
        ? {
            modelOperations: {
              recorder: reportRecorder,
              owner: { type: "current_agent_run" },
              provider: resolved.provider.id,
              model: resolved.model,
              costModel: trackedCostModel,
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

    const writeUndoProtectionWarning = (): void => {
      if (reportRecorder.undoProtection().status === "unavailable") {
        runtime.writeStderr(`${formatUndoCheckpointWarning()}\n`);
      }
    };
    let finalEnd: Awaited<ReturnType<typeof printAgentEvents>>;
    try {
      finalEnd = await printAgentEvents(stream, runtime, reportRecorder);
    } catch (error) {
      if (reportRecorder.undoProtection().latestCheckpoint !== null) {
        runtime.writeStdout("\n");
        writeUndoProtectionWarning();
      }
      throw error;
    }
    // a normally completed runAgent() always emits one terminal end event.
    if (finalEnd !== undefined) {
      reportRecorder.completeAgentRun(finalEnd.turns, finalEnd.stopReason);
      reportRecorder.endTask();
    }
    runtime.writeStdout("\n");
    const undoProtection = reportRecorder.undoProtection();
    writeUndoProtectionWarning();
    if (cliArgs.maxCostUsd !== undefined && finalEnd?.cost !== undefined) {
      runtime.writeStderr(formatCostReport(finalEnd.cost, cliArgs.maxCostUsd));
    }
    if (cliArgs.reportFile !== undefined && finalEnd !== undefined) {
      assertEndEventHasCost(finalEnd);
      writeRunReport(cliArgs.reportFile, {
        tasks: reportRecorder.tasks(),
        modelOperations: reportRecorder.modelOperations(),
        end: finalEnd,
        durationMs: runtime.now() - startedAt,
        contextCompactions: reportRecorder.contextCompactions(),
        skillActivations: [
          ...workflowSkills.map(explicitSkillActivationRecord),
          ...reportRecorder.skillActivations(),
        ],
        activeSkills: reportActiveSkills(
          skillActivation?.activeStatuses() ?? [],
        ),
        skillCatalog: {
          exposed: catalogExposure.skills.length,
          omitted: catalogExposure.omitted,
          total: catalogExposure.total,
          budgetChars: catalogExposure.budgetChars,
          usedChars: catalogExposure.usedChars,
        },
        skillPolicy: skillPolicyReport(skillPolicy, cliArgs.skillsEnabled),
        undoProtection,
        memory: memoryReport(),
      });
    }
    if (
      cliArgs.transcriptFile !== undefined &&
      transcriptMessages !== undefined
    ) {
      writeRunTranscript(cliArgs.transcriptFile, {
        provider: resolved.provider.id,
        model: resolved.model,
        systemPrompt: appendProjectMemoryToSystemPrompt(
          appendWorkflowSkillsToSystemPrompt(
            systemPrompt,
            skillActivation?.active().map(workflowSkillFromActivation) ?? [],
          ),
          transcriptMemoryPrompt,
        ),
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
    if (error instanceof ProjectMemoryError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (
      error instanceof WorkflowSkillError ||
      error instanceof SkillUserConfigError
    ) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof BashProjectApprovalsError) {
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
