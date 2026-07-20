import { createInterface } from "node:readline/promises";
import { isAbortThrow } from "../core/error.ts";
import type { CliArgs } from "./args.ts";
import { extractProjectMemoryCandidates } from "./memory-candidate-extraction.ts";
import { escapeTerminalText } from "./output.ts";
import {
  approveProjectMemoryCandidate,
  clearProjectMemoryCandidates,
  editProjectMemoryCandidate,
  listProjectMemoryCandidates,
  type ProjectMemoryCandidate,
  ProjectMemoryCandidateError,
  purgeProjectMemoryCandidate,
  rejectProjectMemoryCandidate,
  showProjectMemoryCandidate,
} from "./project-memory-candidates.ts";
import { ProjectMemoryEventFileError } from "./project-memory-event-file.ts";
import type { CandidateExtractionOperation } from "./project-memory-events.ts";
import type { CliRuntime } from "./runtime.ts";

type CandidateCliArgs = Extract<
  Extract<CliArgs, { readonly command: "memory" }>,
  { readonly mode: `candidates-${string}` }
>;

export function isMemoryCandidateCliArgs(
  cliArgs: Extract<CliArgs, { readonly command: "memory" }>,
): cliArgs is CandidateCliArgs {
  switch (cliArgs.mode) {
    case "candidates-extract":
    case "candidates-list":
    case "candidates-show":
    case "candidates-edit":
    case "candidates-approve":
    case "candidates-reject":
    case "candidates-purge":
    case "candidates-clear":
      return true;
    default:
      return false;
  }
}

function candidateLine(candidate: ProjectMemoryCandidate): string {
  return `${candidate.id}\t${candidate.status}\t${candidate.kind}\t${escapeTerminalText(candidate.statement)}`;
}

function costLabel(costUsd: number): string {
  return costUsd.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
}

function operationLine(operation: CandidateExtractionOperation): string {
  const provider =
    operation.providerId === null || operation.model === null
      ? "none"
      : `${operation.providerId}/${operation.model}`;
  const usage =
    operation.usage === null
      ? "input=none output=none"
      : `input=${operation.usage.inputTokens} output=${operation.usage.outputTokens}`;
  const cost =
    operation.costUsd === null ? "none" : `$${costLabel(operation.costUsd)}`;
  return `${operation.operationId}\t${operation.outcome}\tsession=${escapeTerminalText(operation.sessionId)}\tprovider=${provider}\tattempts=${operation.attemptCount} retries=${operation.retryCount}\t${usage} cost=${cost}\tfailure=${operation.failure ?? "none"}`;
}

function candidateDetails(
  candidate: ProjectMemoryCandidate,
): readonly string[] {
  const edited = candidate.statement !== candidate.originalStatement;
  const sourceLines = candidate.sources.flatMap((source) => [
    `source session: ${source.sessionId}`,
    `source message: ${source.messageId}`,
    `source quote: ${escapeTerminalText(source.quote)}`,
  ]);
  const originLines =
    candidate.origin.type === "completed_session_extraction"
      ? [
          `origin: completed_session_extraction`,
          `operation: ${candidate.origin.extraction.operationId}`,
          `provider: ${candidate.origin.extraction.providerId}`,
          `model: ${candidate.origin.extraction.model}`,
          `input tokens: ${candidate.origin.extraction.usage.inputTokens}`,
          `cached input tokens: ${candidate.origin.extraction.usage.cachedInputTokens}`,
          `uncached input tokens: ${candidate.origin.extraction.usage.uncachedInputTokens}`,
          `output tokens: ${candidate.origin.extraction.usage.outputTokens}`,
          `attempts: ${candidate.origin.extraction.attemptCount}`,
          `retries: ${candidate.origin.extraction.retryCount}`,
          `cost: $${costLabel(candidate.origin.extraction.costUsd)}`,
        ]
      : [
          `origin: current_turn_proposal`,
          `provider: ${candidate.origin.proposal.providerId}`,
          `model: ${candidate.origin.proposal.model}`,
        ];
  return [
    `id: ${candidate.id}`,
    `status: ${candidate.status}`,
    `kind: ${candidate.kind}`,
    `statement: ${escapeTerminalText(candidate.statement)}`,
    ...(candidate.statement === candidate.originalStatement
      ? []
      : [
          `original statement: ${escapeTerminalText(candidate.originalStatement)}`,
        ]),
    `why: ${escapeTerminalText(candidate.why)}`,
    `created: ${candidate.createdAt}`,
    `expires: ${candidate.expiresAt}`,
    `duplicate memory: ${edited ? "not re-evaluated after edit; exact duplicates are blocked at approval" : candidate.duplicateMemoryIds.length === 0 ? "none" : candidate.duplicateMemoryIds.join(",")}`,
    `conflicting memory: ${edited ? "not re-evaluated after edit; approval requires --keep or --supersede <active-memory-id>" : candidate.conflictMemoryIds.length === 0 ? "none" : candidate.conflictMemoryIds.join(",")}`,
    `sensitivity validation: ${candidate.sensitivityValidation}`,
    `active memory: ${candidate.memoryId ?? "none"}`,
    ...sourceLines,
    ...originLines,
  ];
}

async function confirmClear(
  runtime: CliRuntime,
  purge: boolean,
  purgeLinkedMemories: boolean,
): Promise<boolean> {
  runtime.writeStderr(
    purge
      ? `Purge all project-memory candidate payloads${purgeLinkedMemories ? " and every linked active memory" : ""} from addressable Keel-owned local storage? This cannot erase provider retention, exports, backups, snapshots, or storage-media remnants. [y/N] `
      : "Reject all pending project-memory candidates? Their audit payloads remain on disk. [y/N] ",
  );
  const input = createInterface({
    input: runtime.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    const answer = (await input.question("")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    input.close();
  }
}

export async function runMemoryCandidateCommand(
  cliArgs: CandidateCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  try {
    if (cliArgs.mode === "candidates-extract") {
      const extracted = await extractProjectMemoryCandidates(
        runtime,
        runtime.cwd(),
        {
          sessionId: cliArgs.sessionId,
          maxCostUsd: cliArgs.maxCostUsd,
          providerId: cliArgs.providerId,
          model: cliArgs.model,
          retry: cliArgs.retry,
        },
      );
      runtime.writeStdout(
        [
          `Created ${extracted.candidates.length} project-memory ${extracted.candidates.length === 1 ? "candidate" : "candidates"}; ${extracted.pendingCount} pending.`,
          `Provider: ${extracted.providerId}/${extracted.model}; input tokens: ${extracted.usage.inputTokens}; output tokens: ${extracted.usage.outputTokens}; cost: $${costLabel(extracted.costUsd)}; attempts=${extracted.attemptCount} retries=${extracted.retryCount}.`,
          "Review with: keel memory candidates list",
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (cliArgs.mode === "candidates-list") {
      const listed = listProjectMemoryCandidates(runtime, runtime.cwd());
      runtime.writeStdout(
        [
          ...(listed.candidates.length === 0
            ? [`No project-memory candidates for ${listed.scope.id}.`]
            : [`Project-memory candidates for ${listed.scope.id}:`]),
          ...listed.candidates.map(candidateLine),
          ...(listed.operations.length === 0
            ? []
            : [
                "Candidate extraction operations:",
                ...listed.operations.map(operationLine),
              ]),
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (cliArgs.mode === "candidates-show") {
      const shown = showProjectMemoryCandidate(
        runtime,
        runtime.cwd(),
        cliArgs.id,
      );
      runtime.writeStdout(
        [
          `Project-memory candidate ${shown.candidate.id} for ${shown.scope.id}:`,
          ...candidateDetails(shown.candidate),
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (cliArgs.mode === "candidates-edit") {
      const edited = editProjectMemoryCandidate(
        runtime,
        runtime.cwd(),
        cliArgs.id,
        cliArgs.text,
      );
      runtime.writeStdout(
        `Edited pending project-memory candidate ${edited.id}. Review its full diff with: keel memory candidates show ${edited.id}\n`,
      );
      return 0;
    }
    if (cliArgs.mode === "candidates-approve") {
      const approved = approveProjectMemoryCandidate(
        runtime,
        runtime.cwd(),
        cliArgs.id,
        cliArgs.conflictResolution,
      );
      runtime.writeStdout(
        `Approved project-memory candidate ${approved.candidate.id} as ${approved.memory.id} for ${approved.scope.id}.\n`,
      );
      return 0;
    }
    if (cliArgs.mode === "candidates-reject") {
      const scope = rejectProjectMemoryCandidate(
        runtime,
        runtime.cwd(),
        cliArgs.id,
      );
      runtime.writeStdout(
        `Rejected project-memory candidate ${cliArgs.id} for ${scope.id}. Its audit payload remains on disk.\n`,
      );
      return 0;
    }
    if (cliArgs.mode === "candidates-purge") {
      const purged = purgeProjectMemoryCandidate(
        runtime,
        runtime.cwd(),
        cliArgs.id,
        cliArgs.purgeMemoryId,
      );
      runtime.writeStdout(
        `Purged project-memory candidate ${cliArgs.id}${purged.memoryId === null ? "" : ` and linked memory ${purged.memoryId}`} for ${purged.scope.id} from addressable Keel-owned local storage. This does not erase provider retention, exports, backups, snapshots, or storage-media remnants.\n`,
      );
      return 0;
    }

    if (!cliArgs.confirmed) {
      if (runtime.input.isTTY !== true) {
        runtime.writeStderr(
          cliArgs.purge
            ? "Error: memory candidates clear --purge requires an interactive confirmation or --yes in non-interactive use.\n"
            : "Error: memory candidates clear requires an interactive confirmation or --yes in non-interactive use.\n",
        );
        return 1;
      }
      if (
        !(await confirmClear(
          runtime,
          cliArgs.purge,
          cliArgs.purgeLinkedMemories,
        ))
      ) {
        runtime.writeStdout("Project-memory candidates unchanged.\n");
        return 0;
      }
    }
    const cleared = clearProjectMemoryCandidates(
      runtime,
      runtime.cwd(),
      cliArgs.purge,
      cliArgs.purgeLinkedMemories,
    );
    runtime.writeStdout(
      cliArgs.purge
        ? `Purged ${cleared.cleared} project-memory candidate payload ${cleared.cleared === 1 ? "entry" : "entries"}${cleared.purgedMemoryCount === 0 ? "" : ` and ${cleared.purgedMemoryCount} linked active ${cleared.purgedMemoryCount === 1 ? "memory" : "memories"}`} for ${cleared.scope.id} from addressable Keel-owned local storage.\n`
        : `Rejected ${cleared.cleared} pending project-memory ${cleared.cleared === 1 ? "candidate" : "candidates"} for ${cleared.scope.id}; audit payloads remain on disk.\n`,
    );
    return 0;
  } catch (error) {
    if (isAbortThrow(error)) {
      runtime.writeStdout("\n");
      return 130;
    }
    if (
      !(error instanceof ProjectMemoryCandidateError) &&
      !(error instanceof ProjectMemoryEventFileError)
    ) {
      throw error;
    }
    runtime.writeStderr(`${error.message}\n`);
    return 1;
  }
}
