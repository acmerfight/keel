import { z } from "zod";
import type { ProviderId } from "../core/provider-id.ts";
import { type RunReport, runReportSchema } from "./report-schema.ts";
import type { EvalTask, MemoryPairEvalTask } from "./task.ts";

export const trialOutcomes = [
  "verified",
  "verify_failed",
  "timeout",
  "crashed",
] as const;

export type TrialOutcome = (typeof trialOutcomes)[number];
export type MemoryCondition = "standard" | "memory_disabled" | "memory_enabled";

export interface RecordedToolCall {
  readonly id: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface TranscriptEvidence {
  readonly readable: boolean;
  readonly systemPrompt: string | null;
  readonly providerText: string;
  readonly assistantTexts: readonly string[];
  readonly toolCalls: readonly RecordedToolCall[];
}

export interface TrialResult {
  readonly outcome: TrialOutcome;
  readonly wallMs: number;
  readonly report: RunReport | null;
  readonly transcriptPath: string | null;
  readonly transcript: TranscriptEvidence;
}

export interface ConfiguredMemory {
  readonly ids: readonly string[];
  readonly statuses: readonly ("current" | "stale")[];
  readonly scope: { readonly kind: "project"; readonly id: string } | null;
}

export interface EvalProviderSelection {
  readonly providerId: ProviderId;
  readonly model: string;
}

const pairDeltaSchema = z
  .object({
    successPercentagePoints: z.number(),
    toolCalls: z.number(),
    agentLoopTurns: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    costUsd: z.number().nullable(),
    wallMs: z.number(),
    renderedBytes: z.number().nullable(),
  })
  .strict();

export type PairDelta = z.infer<typeof pairDeltaSchema>;

const resultMemorySchema = z
  .object({
    mode: z.enum(["not_applicable", "disabled", "enabled"]),
    configuredIds: z.array(z.string()),
    scope: z
      .object({ kind: z.literal("project"), id: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

export type ResultMemory = z.infer<typeof resultMemorySchema>;

const recordedToolCallSchema = z
  .object({
    id: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

const providerEvidenceSchema = z
  .object({
    transcriptReadable: z.boolean(),
    finalAssistantText: z.string().max(4_096),
  })
  .strict();

export const evalResultLineSchema = z
  .object({
    schemaVersion: z.literal(2),
    timestamp: z.string(),
    keelVersion: z.string(),
    keelRevision: z.string().nullable(),
    corpusVersion: z.string(),
    taskId: z.string(),
    trial: z.number().int().positive(),
    repetitionCount: z.number().int().positive(),
    seed: z.number().int().nullable(),
    provider: z.string().min(1),
    model: z.string().min(1),
    modelRevision: z.string().nullable(),
    condition: z.enum(["standard", "memory_disabled", "memory_enabled"]),
    requiredToPass: z.boolean(),
    pass: z.boolean(),
    outcome: z.enum(trialOutcomes),
    wallMs: z.number().nonnegative(),
    structuralFailures: z.array(z.string()),
    behavioralFailures: z.array(z.string()),
    memory: resultMemorySchema,
    toolCalls: z.array(recordedToolCallSchema),
    providerEvidence: providerEvidenceSchema,
    pairDelta: pairDeltaSchema.nullable(),
    report: runReportSchema.nullable(),
    transcriptPath: z.string().nullable(),
  })
  .strict()
  .superRefine((line, ctx) => {
    const expectedMode =
      line.condition === "standard"
        ? "not_applicable"
        : line.condition === "memory_disabled"
          ? "disabled"
          : "enabled";
    if (line.memory.mode !== expectedMode) {
      ctx.addIssue({
        code: "custom",
        path: ["memory", "mode"],
        message: `condition ${line.condition} requires memory mode ${expectedMode}`,
      });
    }
    if ((line.condition === "standard") !== (line.pairDelta === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["pairDelta"],
        message:
          line.condition === "standard"
            ? "standard results require a null pair delta"
            : "memory results require a pair delta",
      });
    }
    if (line.condition !== "memory_disabled" && !line.requiredToPass) {
      ctx.addIssue({
        code: "custom",
        path: ["requiredToPass"],
        message: `${line.condition} results must be required to pass`,
      });
    }
    const expectedPass =
      line.outcome === "verified" &&
      line.structuralFailures.length === 0 &&
      line.behavioralFailures.length === 0;
    if (line.pass !== expectedPass) {
      ctx.addIssue({
        code: "custom",
        path: ["pass"],
        message:
          "pass must exactly reflect a verified outcome with no structural or behavioral failures",
      });
    }
    const requiredOutcomeFailure = outcomeBehavioralFailure(line.outcome);
    if (
      requiredOutcomeFailure !== null &&
      !line.behavioralFailures.includes(requiredOutcomeFailure)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["behavioralFailures"],
        message: `${line.outcome} results require their canonical behavioral failure`,
      });
    }
    if (
      line.condition === "standard" &&
      (line.memory.configuredIds.length > 0 || line.memory.scope !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["memory"],
        message: "standard results cannot carry configured memory",
      });
    }
    if (line.condition !== "standard" && line.memory.scope === null) {
      ctx.addIssue({
        code: "custom",
        path: ["memory", "scope"],
        message: "memory-pair results require a configured project scope",
      });
    }
    if (
      !line.providerEvidence.transcriptReadable &&
      (line.providerEvidence.finalAssistantText !== "" ||
        line.toolCalls.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["providerEvidence"],
        message: "unreadable transcripts cannot carry provider evidence",
      });
    }
    if (
      line.transcriptPath !== null &&
      !line.providerEvidence.transcriptReadable
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["transcriptPath"],
        message: "persisted transcript paths require readable evidence",
      });
    }
    const reportedModel = line.report?.modelsUsed[0];
    if (
      reportedModel !== undefined &&
      (line.provider !== reportedModel.provider ||
        line.model !== reportedModel.model)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message: "provider and model must match the run report",
      });
    }
  });

export type EvalResultLine = z.infer<typeof evalResultLineSchema>;

const VERIFIER_FAILURE = "task verifier rejected the resulting workspace";

export function memoryPairGatePasses(
  passPolicy: MemoryPairEvalTask["passPolicy"],
  disabled: EvalResultLine,
  enabled: EvalResultLine,
): boolean {
  const allowedDisabledFailure =
    passPolicy === "enabled_must_pass" &&
    disabled.outcome === "verify_failed" &&
    disabled.structuralFailures.length === 0 &&
    disabled.behavioralFailures.length === 1 &&
    disabled.behavioralFailures[0] === VERIFIER_FAILURE;
  return (disabled.pass || allowedDisabledFailure) && enabled.pass;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameScope(
  left: { readonly kind: "project"; readonly id: string } | null,
  right: { readonly kind: "project"; readonly id: string } | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.id === right.id;
}

function providerContextContains(
  transcript: TranscriptEvidence,
  value: string,
): boolean {
  return transcript.providerText.includes(JSON.stringify(value).slice(1, -1));
}

export function memoryStructuralFailures(
  task: MemoryPairEvalTask,
  condition: "memory_disabled" | "memory_enabled",
  configured: ConfiguredMemory,
  result: TrialResult,
  setupFailures: readonly string[],
): readonly string[] {
  const failures = [...setupFailures];
  if (setupFailures.length > 0) return failures;
  if (configured.scope === null) {
    failures.push("configured memory IDs and scope are incomplete");
  }
  if (result.outcome !== "verified" && result.report === null) return failures;
  if (result.report === null) {
    failures.push("run report is unavailable");
    return failures;
  }
  if (!result.transcript.readable) {
    failures.push("provider-visible transcript is unavailable");
  }

  const memory = result.report.memory;
  if (condition === "memory_disabled") {
    if (memory.enabled) {
      failures.push("--no-memory report says memory is enabled");
    }
    if (memory.scope !== null) {
      failures.push("--no-memory report exposes a scope");
    }
    if (memory.loadedIds.length > 0 || memory.loadedEntries.length > 0) {
      failures.push("--no-memory report exposes loaded memory");
    }
    if (memory.renderedBytes !== 0) {
      failures.push("--no-memory report exposes rendered memory bytes");
    }
    if (memory.estimatedTokens !== 0) {
      failures.push("--no-memory report exposes estimated memory tokens");
    }
    if (memory.operations.length > 0) {
      failures.push("--no-memory report exposes memory operations");
    }
    if (
      [
        ...configured.ids,
        ...task.memorySetup.flatMap((operation) =>
          operation.operation === "forget" ? [] : [operation.text],
        ),
      ].some((value) => providerContextContains(result.transcript, value))
    ) {
      failures.push("--no-memory provider context contains configured memory");
    }
    if (
      result.transcript.toolCalls.some(
        (toolCall) =>
          toolCall.tool === "memory_add" || toolCall.tool === "memory_forget",
      )
    ) {
      failures.push("--no-memory run called a memory mutation tool");
    }
    return failures;
  }

  if (!memory.enabled) failures.push("enabled report says memory is disabled");
  if (!sameScope(memory.scope, configured.scope)) {
    failures.push("enabled report scope differs from configured scope");
  }
  if (!sameStrings(memory.loadedIds, configured.ids)) {
    failures.push("enabled report loaded IDs differ from configured IDs");
  }
  if (
    !sameStrings(
      memory.loadedEntries.map((entry) => entry.id),
      configured.ids,
    )
  ) {
    failures.push("enabled report provenance differs from configured IDs");
  }
  if (
    !sameStrings(
      memory.loadedEntries.map((entry) => entry.status),
      configured.statuses,
    )
  ) {
    failures.push("enabled report lifecycle differs from configured memory");
  }
  if (
    (configured.ids.length > 0 && memory.renderedBytes === 0) ||
    memory.renderedBytes > 4_096
  ) {
    failures.push("enabled report violates the rendered memory byte budget");
  }
  if (memory.operations.length > 0) {
    failures.push("evaluation prompt caused an unauthorized memory mutation");
  }
  return failures;
}

function reportDelta(
  disabled: RunReport | null,
  enabled: RunReport | null,
  select: (report: RunReport) => number,
): number | null {
  return disabled === null || enabled === null
    ? null
    : select(enabled) - select(disabled);
}

export function pairDelta(
  disabled: TrialResult,
  enabled: TrialResult,
  disabledPass: boolean,
  enabledPass: boolean,
): PairDelta {
  return {
    successPercentagePoints: (Number(enabledPass) - Number(disabledPass)) * 100,
    toolCalls:
      enabled.transcript.toolCalls.length -
      disabled.transcript.toolCalls.length,
    agentLoopTurns: reportDelta(
      disabled.report,
      enabled.report,
      (report) => report.agentLoopTurns,
    ),
    inputTokens: reportDelta(
      disabled.report,
      enabled.report,
      (report) => report.usage.inputTokens,
    ),
    outputTokens: reportDelta(
      disabled.report,
      enabled.report,
      (report) => report.usage.outputTokens,
    ),
    costUsd: reportDelta(
      disabled.report,
      enabled.report,
      (report) => report.costUsd,
    ),
    wallMs: enabled.wallMs - disabled.wallMs,
    renderedBytes: reportDelta(
      disabled.report,
      enabled.report,
      (report) => report.memory.renderedBytes,
    ),
  };
}

export function resultMemory(
  condition: MemoryCondition,
  configured: ConfiguredMemory | null,
): ResultMemory {
  if (condition === "standard") {
    return { mode: "not_applicable", configuredIds: [], scope: null };
  }
  return {
    mode: condition === "memory_disabled" ? "disabled" : "enabled",
    configuredIds: [...(configured?.ids ?? [])],
    scope: configured?.scope ?? null,
  };
}

function outcomeBehavioralFailure(outcome: TrialOutcome): string | null {
  switch (outcome) {
    case "verified":
      return null;
    case "verify_failed":
      return VERIFIER_FAILURE;
    case "timeout":
      return "agent or verifier timed out";
    case "crashed":
      return "agent or evaluation harness crashed";
  }
}

function taskBehavioralFailures(
  task: EvalTask,
  result: TrialResult,
): readonly string[] {
  const failures = new Set<string>();
  const outcomeFailure = outcomeBehavioralFailure(result.outcome);
  if (outcomeFailure !== null) failures.add(outcomeFailure);
  if (task.kind === "standard") return [...failures];

  for (const forbidden of task.forbiddenAttempts) {
    const matched =
      forbidden.source === "assistant_text"
        ? result.transcript.assistantTexts.some((text) =>
            text.includes(forbidden.contains),
          )
        : result.transcript.toolCalls.some(
            (toolCall) =>
              forbidden.tools.some((tool) => tool === toolCall.tool) &&
              JSON.stringify(toolCall.arguments).includes(forbidden.contains),
          );
    if (matched) failures.add(forbidden.failure);
  }
  return [...failures];
}

export function evalTrialPasses(
  task: EvalTask,
  result: TrialResult,
  structuralFailures: readonly string[],
): boolean {
  return (
    result.outcome === "verified" &&
    structuralFailures.length === 0 &&
    taskBehavioralFailures(task, result).length === 0
  );
}

export function createEvalResultLine(options: {
  readonly version: string;
  readonly revision: string | null;
  readonly task: EvalTask;
  readonly trial: number;
  readonly repetitionCount: number;
  readonly condition: MemoryCondition;
  readonly requiredToPass: boolean;
  readonly result: TrialResult;
  readonly structuralFailures: readonly string[];
  readonly memory: ResultMemory;
  readonly pairDelta: PairDelta | null;
  readonly selection: EvalProviderSelection;
}): EvalResultLine {
  const behavioralFailures = taskBehavioralFailures(
    options.task,
    options.result,
  );
  const pass = evalTrialPasses(
    options.task,
    options.result,
    options.structuralFailures,
  );
  const finalAssistantText =
    options.result.transcript.assistantTexts.at(-1)?.slice(-4_096) ?? "";
  return {
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
    keelVersion: options.version,
    keelRevision: options.revision,
    corpusVersion: options.task.corpusVersion,
    taskId: options.task.id,
    trial: options.trial,
    repetitionCount: options.repetitionCount,
    seed: null,
    provider: options.selection.providerId,
    model: options.selection.model,
    modelRevision: null,
    condition: options.condition,
    requiredToPass: options.requiredToPass,
    pass,
    outcome: options.result.outcome,
    wallMs: options.result.wallMs,
    structuralFailures: [...options.structuralFailures],
    behavioralFailures: [...behavioralFailures],
    memory: {
      mode: options.memory.mode,
      configuredIds: [...options.memory.configuredIds],
      scope: options.memory.scope,
    },
    toolCalls: options.result.transcript.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      tool: toolCall.tool,
      arguments: toolCall.arguments,
    })),
    providerEvidence: {
      transcriptReadable: options.result.transcript.readable,
      finalAssistantText,
    },
    pairDelta: options.pairDelta,
    report: options.result.report,
    transcriptPath: options.result.transcriptPath,
  };
}
