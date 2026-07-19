import type {
  AgentMemoryMutationCapability,
  AgentMemoryProposalCapability,
} from "../tools/memory.ts";
import {
  addProjectMemory,
  forgetProjectMemory,
  listProjectMemory,
  type ProjectMemoryRuntime,
} from "./project-memory.ts";
import {
  approveReviewedProjectMemoryCandidate,
  recordCurrentTurnCandidateProposal,
  rejectProjectMemoryCandidate,
} from "./project-memory-candidates.ts";
import type { RunReportMemoryOperation } from "./report.ts";

export interface AgentProjectMemory {
  readonly capability: AgentMemoryMutationCapability;
  readonly proposalCapability: AgentMemoryProposalCapability;
  readonly operations: () => readonly RunReportMemoryOperation[];
}

export function createAgentProjectMemory(options: {
  readonly runtime: ProjectMemoryRuntime;
  readonly workspace: string;
}): AgentProjectMemory {
  const operations: RunReportMemoryOperation[] = [];
  return {
    capability: {
      list: () =>
        listProjectMemory(options.runtime, options.workspace, {
          all: false,
        }).entries.map((entry) => ({ id: entry.id, text: entry.text })),
      add: (text, evidence) => {
        const saved = addProjectMemory(
          options.runtime,
          options.workspace,
          text,
          {
            type: "user_explicit",
            channel: "agent",
            evidence,
          },
          { reviewAfter: null, expiresAt: null },
        );
        operations.push({
          operation: "add",
          id: saved.entry.id,
          scope: saved.scope,
          outcome: "saved",
        });
        return { id: saved.entry.id, scope: saved.scope };
      },
      forget: (id, evidence) => {
        const scope = forgetProjectMemory(
          options.runtime,
          options.workspace,
          id,
          {
            type: "user_explicit",
            channel: "agent",
            evidence,
          },
        );
        operations.push({
          operation: "forget",
          id,
          scope,
          outcome: "forgotten",
        });
        return { id, scope };
      },
    },
    proposalCapability: {
      propose: async (proposal, source, review, signal) => {
        const sourceRecord = {
          sessionId: source.sessionId,
          messageId: source.messageId,
          quote: proposal.sourceQuote,
        };
        const recorded = recordCurrentTurnCandidateProposal(
          options.runtime,
          options.workspace,
          {
            sessionId: source.sessionId,
            messageId: source.messageId,
            providerId: source.providerId,
            model: source.model,
            createdAt: new Date(options.runtime.now()).toISOString(),
          },
          {
            kind: proposal.kind,
            statement: proposal.statement,
            why: proposal.why,
            sources: [sourceRecord],
            conflictMemoryIds: proposal.conflictMemoryIds,
          },
        );
        const pending = () => {
          const operation = {
            operation: "propose" as const,
            candidateId: recorded.candidate.id,
            memoryId: null,
            scope: recorded.scope,
            outcome: "pending" as const,
          };
          operations.push(operation);
          return operation;
        };
        if (recorded.candidate.conflictMemoryIds.length > 0) {
          return pending();
        }
        const decision = await review(
          {
            candidateId: recorded.candidate.id,
            scope: recorded.scope,
            kind: recorded.candidate.kind,
            statement: recorded.candidate.statement,
            why: recorded.candidate.why,
            sourceQuote: sourceRecord.quote,
            conflictMemoryIds: recorded.candidate.conflictMemoryIds,
          },
          signal,
        );
        if (decision.type === "pending") {
          return pending();
        }
        if (decision.type === "reject") {
          rejectProjectMemoryCandidate(
            options.runtime,
            options.workspace,
            recorded.candidate.id,
          );
          const operation = {
            operation: "propose" as const,
            candidateId: recorded.candidate.id,
            memoryId: null,
            scope: recorded.scope,
            outcome: "rejected" as const,
          };
          operations.push(operation);
          return operation;
        }
        const approved = approveReviewedProjectMemoryCandidate(
          options.runtime,
          options.workspace,
          recorded.candidate.id,
          {
            statement: recorded.candidate.statement,
            source: sourceRecord,
            sessionId: source.sessionId,
          },
        );
        const operation = {
          operation: "propose" as const,
          candidateId: recorded.candidate.id,
          memoryId: approved.memory.id,
          scope: recorded.scope,
          outcome: "approved" as const,
        };
        operations.push(operation);
        return operation;
      },
    },
    operations: () => [...operations],
  };
}
