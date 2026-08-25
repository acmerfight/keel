import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { runAgent } from "../agent/loop.ts";
import type { MainModelOperationInstrumentation } from "../agent/model-operations.ts";
import {
  appendDelegationToSystemPrompt,
  appendProjectMemoryToSystemPrompt,
  appendWorkflowSkillsToSystemPrompt,
  buildAgentSystemPrompt,
} from "../agent/prompt.ts";
import type { SessionMessage } from "../agent/session-message.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import { isAbortThrow } from "../core/error.ts";
import type { ExecutionPosture } from "../core/execution-posture.ts";
import { createMcpRuntime } from "../mcp/runtime.ts";
import type { McpPermissionPolicy, McpRuntime } from "../mcp/runtime-types.ts";
import type { MainBashRuntime } from "../permissions/bash.ts";
import { createAgentInvocationContext } from "../runtime/invocation-context.ts";
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
import { createPromptedBashPermissionPolicy } from "./interactive-session/bash-approval.ts";
import {
  createLineReader,
  type LineReader,
} from "./interactive-session/line-reader.ts";
import {
  createPromptedMcpPermissionPolicy,
  trustedMcpPermissionPolicy,
} from "./mcp-approval.ts";
import { listMcpServers } from "./mcp-config.ts";
import {
  createCliMcpAuthProvider,
  createCliMcpConnectionFactory,
  createCliMcpLifecyclePolicy,
} from "./mcp-connection.ts";
import {
  formatCostReport,
  formatSubagentProgress,
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
  type RunReportSubagents,
  reportActiveSkills,
  writeRunReport,
  writeRunReportBestEffort,
} from "./report.ts";
import { createAgentEventReportRecorder } from "./report-events.ts";
import type { CliRuntime } from "./runtime.ts";
import {
  createCliRuntimeErrorReporter,
  formatCliRuntimeError,
} from "./runtime-error.ts";
import { sessionHome } from "./session-store.ts";
import {
  resolveSkillRuntimePolicy,
  SkillUserConfigError,
  skillPolicyReport,
} from "./skill-user-config.ts";
import { createCliSubagentRuntime } from "./subagent-runtime.ts";
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

type OneShotRunCliArgs = Extract<
  CliArgs,
  { readonly command: "run"; readonly mode: "one-shot" }
>;

function oneShotBashRuntime(
  executionPosture: ExecutionPosture,
  writeStderr: (text: string) => void,
  lineReader: LineReader | undefined,
): MainBashRuntime {
  if (executionPosture === "trusted") {
    return { kind: "trusted" };
  }

  /* v8 ignore next 3 -- TTY ask mode creates the shared approval reader before this private adapter is called. */
  if (lineReader === undefined) {
    throw new Error("TTY bash approval requires an approval line reader");
  }
  const policy = createPromptedBashPermissionPolicy(lineReader, writeStderr);
  return { kind: "reviewed", permission: policy };
}

function oneShotMcpPermissionPolicy(
  executionPosture: ExecutionPosture,
  writeStderr: (text: string) => void,
  lineReader: LineReader | undefined,
): McpPermissionPolicy {
  if (executionPosture === "trusted") return trustedMcpPermissionPolicy;

  /* v8 ignore next 3 -- TTY ask mode creates the shared approval reader before this private adapter is called. */
  if (lineReader === undefined) {
    throw new Error("TTY MCP approval requires an approval line reader");
  }
  return createPromptedMcpPermissionPolicy(lineReader, writeStderr);
}

export async function runOneShotCli(
  cliArgs: OneShotRunCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  if (cliArgs.executionPosture === "reviewed" && runtime.input.isTTY !== true) {
    runtime.writeStderr(
      "Error: --approval-policy ask requires a real TTY and is unavailable to piped or non-TTY runs.\n",
    );
    return 1;
  }
  const originalUserMessage = cliArgs.userMessage;
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  let closeApprovalInput: (() => void) | undefined;
  let mcpRuntime: McpRuntime | undefined;
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
    const resolvedProvider = resolveProvider(userMessage, runtime, {
      ...(cliArgs.providerId !== undefined
        ? { providerId: cliArgs.providerId }
        : {}),
      ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    });
    const resolved = createAgentInvocationContext(resolvedProvider);
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
    const mcpServers = await listMcpServers(runtime);
    const mcpConnectionFactory = createCliMcpConnectionFactory(runtime);
    const mcpLifecycle = createCliMcpLifecyclePolicy(runtime);
    const needsApprovalInput =
      runtime.input.isTTY === true && cliArgs.executionPosture === "reviewed";
    const approvalInput = needsApprovalInput
      ? createInterface({
          input: runtime.input,
          crlfDelay: Number.POSITIVE_INFINITY,
        })
      : undefined;
    closeApprovalInput = () => approvalInput?.close();
    const approvalLineReader =
      approvalInput === undefined
        ? undefined
        : createLineReader(approvalInput, {});
    const bashRuntime = oneShotBashRuntime(
      cliArgs.executionPosture,
      runtime.writeStderr,
      approvalLineReader,
    );
    if (mcpServers.length > 0) {
      mcpRuntime = createMcpRuntime({
        servers: mcpServers,
        connectionFactory: mcpConnectionFactory,
        lifecycle: mcpLifecycle,
        permission: oneShotMcpPermissionPolicy(
          cliArgs.executionPosture,
          runtime.writeStderr,
          approvalLineReader,
        ),
        now: runtime.now,
        schemaTarget: resolved.schemaTarget,
      });
    }
    await cleanupExpiredToolOutputArtifacts({ runtime });
    const toolOutputArtifacts = {
      store: createToolOutputArtifactStore({
        runtime,
        scope: newToolOutputArtifactScope("run"),
      }),
    };
    const baseSystemPrompt = buildAgentSystemPrompt({
      workspace,
      platform: runtime.platform,
      ...(projectInstructions !== undefined ? { projectInstructions } : {}),
      ...(catalogExposure.skills.length > 0
        ? { skillCatalog: catalogExposure.skills }
        : {}),
    });
    const systemPrompt =
      cliArgs.agentPolicy === "off"
        ? baseSystemPrompt
        : appendDelegationToSystemPrompt(
            baseSystemPrompt,
            cliArgs.agentPolicy,
            {
              background: false,
              nestedReadOnly: cliArgs.agentPolicy === "explicit",
              writer: cliArgs.agentPolicy === "explicit",
            },
          );
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
        status: "available",
        scope: loadedMemory.scope,
        loadedIds: [...exposedMemoryEntries.keys()],
        loadedEntries: [...exposedMemoryEntries.values()],
        renderedBytes: exposedMemoryBytes,
        estimatedTokens: exposedMemoryTokens,
        operations: agentMemory.operations(),
      });
    } else {
      memoryReport = () => ({
        status: "disabled",
        scope: null,
        loadedIds: [],
        loadedEntries: [],
        renderedBytes: 0,
        estimatedTokens: 0,
        operations: [],
      });
    }
    const modelMaxOutputTokens = resolved.modelMaxOutputTokens;
    const delegationRun =
      cliArgs.agentPolicy === "off"
        ? ({ kind: "off" } as const)
        : ({
            kind: "enabled",
            policy: cliArgs.agentPolicy,
            maxCostUsd: cliArgs.maxCostUsd,
            costModel: requireKnownCostModel(resolved),
          } as const);
    const trackedCostModel =
      delegationRun.kind === "enabled"
        ? delegationRun.costModel
        : cliArgs.maxCostUsd !== undefined || cliArgs.reportFile !== undefined
          ? requireKnownCostModel(resolved)
          : undefined;
    const reportRecorder = createAgentEventReportRecorder();
    reportRecorder.recordSkillCatalog({
      exposed: catalogExposure.skills.length,
      omitted: catalogExposure.omitted,
      total: catalogExposure.total,
      budgetChars: catalogExposure.budgetChars,
      usedChars: catalogExposure.usedChars,
    });
    reportRecorder.beginTask("user_prompt");
    reportRecorder.beginAgentRun("user_prompt");
    const modelOperations: MainModelOperationInstrumentation | undefined =
      cliArgs.reportFile !== undefined && trackedCostModel !== undefined
        ? {
            recorder: reportRecorder,
            owner: { type: "current_agent_run" },
            provider: resolved.provider.id,
            model: resolved.model,
            costModel: trackedCostModel,
          }
        : undefined;
    const subagentRuntime =
      delegationRun.kind === "enabled"
        ? await createCliSubagentRuntime({
            workspace,
            workspaceLeasesRoot: join(sessionHome(runtime), "worktrees"),
            platform: runtime.platform,
            parentRunId: `main-${randomUUID()}`,
            provider: resolved.provider,
            providerId: resolved.providerId,
            model: resolved.model,
            policy: delegationRun.policy,
            executionPosture: cliArgs.executionPosture,
            maxCostUsd: delegationRun.maxCostUsd,
            costModel: delegationRun.costModel,
            modelMetadata: resolved.modelMetadata ?? {
              status: "unknown" as const,
            },
            projectInstructions,
            hiddenWorkspacePaths,
            ...(catalog !== undefined ? { skillCatalog: catalog } : {}),
            ...(mcpServers.length > 0
              ? {
                  mcp: {
                    servers: mcpServers,
                    connectionFactory: (authorizationIdentity) =>
                      createCliMcpConnectionFactory(
                        runtime,
                        authorizationIdentity,
                      ),
                    lifecycle: mcpLifecycle,
                    authorizationIdentity: async (server) =>
                      await createCliMcpAuthProvider(
                        runtime,
                        server,
                      ).authorizationIdentity(),
                  },
                }
              : {}),
            contextCompaction: resolved.contextCompaction,
            modelMaxOutputTokens,
            modelOperations,
            transcriptStore: toolOutputArtifacts.store,
            now: runtime.now,
            onProgress: (event) => {
              runtime.writeStderr(formatSubagentProgress(event));
            },
            resolveProvider: (selection) => {
              const child = createAgentInvocationContext(
                resolveProvider(originalUserMessage, runtime, selection),
              );
              const childModelMaxOutputTokens = child.modelMaxOutputTokens;
              return {
                provider: child.provider,
                providerId: child.providerId,
                model: child.model,
                costModel: requireKnownCostModel(child),
                modelMetadata: child.modelMetadata ?? {
                  status: "unknown" as const,
                },
                ...(child.contextCompaction !== undefined
                  ? { contextCompaction: child.contextCompaction }
                  : {}),
                ...(childModelMaxOutputTokens !== undefined
                  ? {
                      modelMaxOutputTokens: childModelMaxOutputTokens,
                    }
                  : {}),
              };
            },
          })
        : undefined;
    const reportSubagents = (): RunReportSubagents => ({
      status: "observed",
      runs:
        subagentRuntime?.supervisor.runSnapshots().map((run) => ({
          delegationId: run.delegationId,
          childRunId: run.childRunId,
          status: run.state === "terminal" ? run.terminal.status : run.state,
        })) ?? [],
    });
    let transcriptMessages: readonly SessionMessage[] | undefined;
    const stream = runAgent({
      workspace,
      provider: resolved.provider,
      userMessage,
      systemPrompt,
      ...(memoryPrompt !== undefined
        ? {
            memory: {
              kind: "direct",
              prompt: memoryPrompt,
              mutation: agentMemory.capability,
            },
          }
        : {}),
      signal: abortController.signal,
      bash: bashRuntime,
      ...(subagentRuntime !== undefined
        ? { delegation: subagentRuntime.supervisor.capability }
        : {}),
      ...(subagentRuntime !== undefined
        ? { costBudgetProvider: subagentRuntime.costBudgetProvider }
        : {}),
      ...(mcpRuntime !== undefined
        ? {
            mcp: {
              runtime: mcpRuntime,
              schemaTarget: resolved.schemaTarget,
            },
          }
        : {}),
      ...(hiddenWorkspacePaths.length > 0 ? { hiddenWorkspacePaths } : {}),
      ...(skillActivation !== undefined ? { skillActivation } : {}),
      stopPolicy: defaultStopPolicy(),
      toolOutputArtifacts,
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
      ...(modelOperations !== undefined ? { modelOperations } : {}),
      ...(resolved.contextCompaction !== undefined
        ? { contextCompaction: resolved.contextCompaction }
        : {}),
      ...(cliArgs.transcriptFile !== null
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
      if (
        !isAbortThrow(error, abortController.signal) &&
        cliArgs.reportFile !== undefined
      ) {
        reportRecorder.failAgentRun();
        reportRecorder.endTask("failed");
        writeRunReportBestEffort(
          cliArgs.reportFile,
          {
            executionPosture: cliArgs.executionPosture,
            tasks: reportRecorder.tasks(),
            modelOperations: reportRecorder.modelOperations(),
            subagents: reportSubagents(),
            outcome: {
              status: "failed",
              error,
              ...(cliArgs.maxCostUsd !== undefined
                ? { maxCostUsd: cliArgs.maxCostUsd }
                : {}),
            },
            durationMs: runtime.now() - startedAt,
            contextCompactions: reportRecorder.contextCompactions(),
            skillActivations: [
              ...workflowSkills.map(explicitSkillActivationRecord),
              ...reportRecorder.skillActivations(),
            ],
            activeSkills: reportActiveSkills(
              skillActivation?.activeStatuses() ?? [],
            ),
            skillCatalog: reportRecorder.skillCatalog(),
            skillPolicy: skillPolicyReport(skillPolicy, cliArgs.skillsEnabled),
            undoProtection: reportRecorder.undoProtection(),
            memory: memoryReport(),
          },
          createCliRuntimeErrorReporter(runtime.writeStderr),
        );
      }
      throw error;
    }
    /* v8 ignore next -- a normally completed runAgent() always emits one terminal end event. */
    if (finalEnd !== undefined) {
      reportRecorder.completeAgentRun(finalEnd.turns, finalEnd.stopReason);
      reportRecorder.endTask();
    }
    runtime.writeStdout("\n");
    const undoProtection = reportRecorder.undoProtection();
    writeUndoProtectionWarning();
    if (cliArgs.maxCostUsd !== undefined && finalEnd?.cost !== undefined) {
      runtime.writeStderr(formatCostReport(finalEnd.cost));
    }
    if (cliArgs.reportFile !== undefined && finalEnd !== undefined) {
      assertEndEventHasCost(finalEnd);
      writeRunReport(cliArgs.reportFile, {
        executionPosture: cliArgs.executionPosture,
        tasks: reportRecorder.tasks(),
        modelOperations: reportRecorder.modelOperations(),
        subagents: reportSubagents(),
        outcome: { status: "completed", end: finalEnd },
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
    if (cliArgs.transcriptFile !== null && transcriptMessages !== undefined) {
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
    if (isAbortThrow(error, abortController.signal)) {
      runtime.writeStdout("\n");
      return 130;
    }
    runtime.writeStderr(formatCliRuntimeError(error));
    return 1;
  } finally {
    await mcpRuntime?.close().catch(() => undefined);
    closeApprovalInput?.();
    runtime.offSigint(abort);
  }
  return 0;
}
