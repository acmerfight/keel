import { createHash } from "node:crypto";
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

export interface RecordedReadObservation {
  readonly toolCallId: string;
  readonly targetPathSha256: string;
  readonly toolCallCountAtObservation: number;
}

export interface TranscriptEvidence {
  readonly readable: boolean;
  readonly systemPrompt: string | null;
  readonly providerText: string;
  readonly assistantTexts: readonly string[];
  readonly toolCalls: readonly RecordedToolCall[];
  readonly readObservations: readonly RecordedReadObservation[];
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

const projectScopeSchema = z
  .object({ kind: z.literal("project"), id: z.string() })
  .strict();

const resultMemorySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("not_applicable"),
      configuredIds: z.tuple([]),
      scope: z.null(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("setup_failed"),
      configuredIds: z.tuple([]),
      scope: z.null(),
    })
    .strict(),
  z
    .object({
      mode: z.enum(["disabled", "enabled"]),
      configuredIds: z.array(z.string()),
      scope: projectScopeSchema,
    })
    .strict(),
]);

export type ResultMemory = z.infer<typeof resultMemorySchema>;

const recordedToolCallSchema = z
  .object({
    id: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

const matchedEvidenceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("assistant_text"),
      failure: z.string().min(1),
      excerpt: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      source: z.literal("tool_arguments"),
      failure: z.string().min(1),
      toolCallId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("missing_read_evidence"),
      failure: z.string().min(1),
      path: z.string().min(1),
      beforeTools: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

type MatchedEvidence = z.infer<typeof matchedEvidenceSchema>;

const recordedReadObservationSchema = z
  .object({
    toolCallId: z.string().min(1),
    targetPathSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    toolCallCountAtObservation: z.number().int().nonnegative(),
  })
  .strict();

const providerEvidenceSchema = z
  .object({
    transcriptReadable: z.boolean(),
    finalAssistantText: z.string().max(4_096),
    matchedEvidence: z.array(matchedEvidenceSchema),
    readObservations: z.array(recordedReadObservationSchema),
  })
  .strict();

function pathSha256(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function hasRequiredReadEvidence(
  toolCalls: readonly RecordedToolCall[],
  readObservations: readonly RecordedReadObservation[],
  path: string,
  beforeTools: readonly string[],
): boolean {
  const dependentCallIndex = toolCalls.findIndex((toolCall) =>
    beforeTools.includes(toolCall.tool),
  );
  if (dependentCallIndex < 0) return false;
  const targetPathSha256 = pathSha256(path);
  return toolCalls.some(
    (toolCall, index) =>
      index < dependentCallIndex &&
      toolCall.tool === "read" &&
      readObservations.some(
        (observation) =>
          observation.toolCallId === toolCall.id &&
          observation.targetPathSha256 === targetPathSha256 &&
          observation.toolCallCountAtObservation <= dependentCallIndex,
      ),
  );
}

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
    if (
      line.memory.mode !== expectedMode &&
      !(line.condition !== "standard" && line.memory.mode === "setup_failed")
    ) {
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
      !line.providerEvidence.transcriptReadable &&
      (line.providerEvidence.finalAssistantText !== "" ||
        line.toolCalls.length > 0 ||
        line.providerEvidence.readObservations.length > 0 ||
        line.providerEvidence.matchedEvidence.some(
          (evidence) => evidence.source !== "missing_read_evidence",
        ))
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
    const canonicalFailures = new Set(
      trialOutcomes.flatMap((outcome) => {
        const failure = outcomeBehavioralFailure(outcome);
        return failure === null ? [] : [failure];
      }),
    );
    for (const failure of line.behavioralFailures) {
      if (
        !canonicalFailures.has(failure) &&
        !line.providerEvidence.matchedEvidence.some(
          (evidence) => evidence.failure === failure,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["providerEvidence", "matchedEvidence"],
          message: `behavioral failure ${JSON.stringify(failure)} requires matched evidence`,
        });
      }
    }
    const toolCallIds = new Set<string>();
    for (const toolCall of line.toolCalls) {
      if (toolCallIds.has(toolCall.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["toolCalls"],
          message: `tool call IDs must be unique: ${JSON.stringify(toolCall.id)}`,
        });
      }
      toolCallIds.add(toolCall.id);
    }
    for (const evidence of line.providerEvidence.matchedEvidence) {
      if (!line.behavioralFailures.includes(evidence.failure)) {
        ctx.addIssue({
          code: "custom",
          path: ["providerEvidence", "matchedEvidence"],
          message: `matched evidence ${JSON.stringify(evidence.failure)} requires a behavioral failure`,
        });
      }
      if (
        evidence.source === "tool_arguments" &&
        !line.toolCalls.some((toolCall) => toolCall.id === evidence.toolCallId)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["providerEvidence", "matchedEvidence"],
          message: `matched evidence references unknown tool call ${JSON.stringify(evidence.toolCallId)}`,
        });
      }
      if (
        evidence.source === "missing_read_evidence" &&
        hasRequiredReadEvidence(
          line.toolCalls,
          line.providerEvidence.readObservations,
          evidence.path,
          evidence.beforeTools,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["providerEvidence", "matchedEvidence"],
          message: `missing-read evidence contradicts recorded read ${JSON.stringify(evidence.path)}`,
        });
      }
    }
    const readObservationIds = new Set<string>();
    for (const observation of line.providerEvidence.readObservations) {
      const toolCallIndex = line.toolCalls.findIndex(
        (candidate) => candidate.id === observation.toolCallId,
      );
      const toolCall = line.toolCalls[toolCallIndex];
      if (
        toolCall?.tool !== "read" ||
        readObservationIds.has(observation.toolCallId) ||
        observation.toolCallCountAtObservation <= toolCallIndex ||
        observation.toolCallCountAtObservation > line.toolCalls.length
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["providerEvidence", "readObservations"],
          message: `read observation must occur after one unique recorded read call ${JSON.stringify(observation.toolCallId)}`,
        });
      }
      readObservationIds.add(observation.toolCallId);
    }
    if (line.memory.mode === "setup_failed") {
      const exactSetupFailure =
        line.condition !== "standard" &&
        line.outcome === "crashed" &&
        !line.pass &&
        line.structuralFailures.length > 0 &&
        line.structuralFailures.every((failure) =>
          failure.startsWith("memory fixture setup failed:"),
        ) &&
        line.report === null &&
        !line.providerEvidence.transcriptReadable &&
        line.providerEvidence.finalAssistantText === "" &&
        line.providerEvidence.matchedEvidence.every(
          (evidence) => evidence.source === "missing_read_evidence",
        ) &&
        line.providerEvidence.readObservations.length === 0 &&
        line.toolCalls.length === 0 &&
        line.transcriptPath === null;
      if (!exactSetupFailure) {
        ctx.addIssue({
          code: "custom",
          path: ["memory", "mode"],
          message: "setup_failed requires the exact fail-closed fixture state",
        });
      }
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
  if (configured === null || configured.scope === null) {
    return { mode: "setup_failed", configuredIds: [], scope: null };
  }
  return {
    mode: condition === "memory_disabled" ? "disabled" : "enabled",
    configuredIds: [...configured.ids],
    scope: configured.scope,
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

interface BehavioralClassification {
  readonly failures: readonly string[];
  readonly matchedEvidence: readonly MatchedEvidence[];
}

function assistantExcerpt(text: string, contains: string): string {
  const match = text.indexOf(contains);
  const start = Math.max(0, match - 96);
  return text.slice(start, start + 256);
}

function classifyBehavior(
  task: EvalTask,
  result: TrialResult,
  condition: MemoryCondition,
): BehavioralClassification {
  const failures = new Set<string>();
  const matchedEvidence: MatchedEvidence[] = [];
  const outcomeFailure = outcomeBehavioralFailure(result.outcome);
  if (outcomeFailure !== null) failures.add(outcomeFailure);
  if (task.kind === "standard") {
    return { failures: [...failures], matchedEvidence };
  }

  for (const forbidden of task.forbiddenAttempts) {
    if (forbidden.source === "assistant_text") {
      const text = result.transcript.assistantTexts.find((candidate) =>
        candidate.includes(forbidden.contains),
      );
      if (text === undefined) continue;
      failures.add(forbidden.failure);
      matchedEvidence.push({
        source: "assistant_text",
        failure: forbidden.failure,
        excerpt: assistantExcerpt(text, forbidden.contains),
      });
      continue;
    }
    const toolCall = result.transcript.toolCalls.find(
      (candidate) =>
        forbidden.tools.some((tool) => tool === candidate.tool) &&
        JSON.stringify(candidate.arguments).includes(forbidden.contains),
    );
    if (toolCall === undefined) continue;
    failures.add(forbidden.failure);
    matchedEvidence.push({
      source: "tool_arguments",
      failure: forbidden.failure,
      toolCallId: toolCall.id,
    });
  }
  for (const required of task.requiredToolEvidence) {
    if (required.condition !== condition) continue;
    const present = hasRequiredReadEvidence(
      result.transcript.toolCalls,
      result.transcript.readObservations,
      required.path,
      required.beforeTools,
    );
    if (present) continue;
    failures.add(required.failure);
    matchedEvidence.push({
      source: "missing_read_evidence",
      failure: required.failure,
      path: required.path,
      beforeTools: [...required.beforeTools],
    });
  }
  return { failures: [...failures], matchedEvidence };
}

export function evalTrialPasses(
  task: EvalTask,
  result: TrialResult,
  structuralFailures: readonly string[],
  condition: MemoryCondition,
): boolean {
  return (
    result.outcome === "verified" &&
    structuralFailures.length === 0 &&
    classifyBehavior(task, result, condition).failures.length === 0
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
  const behavior = classifyBehavior(
    options.task,
    options.result,
    options.condition,
  );
  const pass =
    options.result.outcome === "verified" &&
    options.structuralFailures.length === 0 &&
    behavior.failures.length === 0;
  const finalAssistantText =
    options.result.transcript.assistantTexts.at(-1)?.slice(-4_096) ?? "";
  const line = {
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
    behavioralFailures: [...behavior.failures],
    memory: options.memory,
    toolCalls: options.result.transcript.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      tool: toolCall.tool,
      arguments: toolCall.arguments,
    })),
    providerEvidence: {
      transcriptReadable: options.result.transcript.readable,
      finalAssistantText,
      matchedEvidence: [...behavior.matchedEvidence],
      readObservations: [...options.result.transcript.readObservations],
    },
    pairDelta: options.pairDelta,
    report: options.result.report,
    transcriptPath: options.result.transcriptPath,
  };
  return evalResultLineSchema.parse(line);
}
