import type { AgentMemoryMutationCapability } from "../tools/memory.ts";
import {
  addProjectMemory,
  forgetProjectMemory,
  listProjectMemory,
  type ProjectMemoryRuntime,
} from "./project-memory.ts";
import type { RunReportMemoryOperation } from "./report.ts";

export interface AgentProjectMemory {
  readonly capability: AgentMemoryMutationCapability;
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
      add: (text, sourceText) => {
        const saved = addProjectMemory(
          options.runtime,
          options.workspace,
          text,
          {
            type: "user_explicit",
            channel: "agent",
            evidence: sourceText,
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
      forget: (id, sourceText) => {
        const scope = forgetProjectMemory(
          options.runtime,
          options.workspace,
          id,
          {
            type: "user_explicit",
            channel: "agent",
            evidence: sourceText,
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
    operations: () => [...operations],
  };
}
