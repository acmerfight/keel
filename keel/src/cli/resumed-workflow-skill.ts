import type { WorkflowSkill } from "../agent/prompt.ts";
import { type SessionState, SessionStoreError } from "./session-store.ts";

interface ResumedWorkflowSkillOptions {
  readonly session: SessionState;
  readonly requestedSkillName?: string;
}

export function ensureResumedWorkflowSkillMatchesRequest(
  options: ResumedWorkflowSkillOptions,
): void {
  const workflowSkill = options.session.workflowSkill;
  if (options.requestedSkillName === undefined) {
    return;
  }
  if (workflowSkill === undefined) {
    throw new SessionStoreError(
      `Error: session "${options.session.id}" has no workflow skill; cannot resume it with workflow skill "${options.requestedSkillName}".`,
    );
  }
  if (workflowSkill.name !== options.requestedSkillName) {
    throw new SessionStoreError(
      `Error: session "${options.session.id}" already uses workflow skill "${workflowSkill.name}"; cannot resume it with workflow skill "${options.requestedSkillName}".`,
    );
  }
}

export function resolveResumedWorkflowSkill(
  options: ResumedWorkflowSkillOptions,
): WorkflowSkill | undefined {
  ensureResumedWorkflowSkillMatchesRequest(options);
  return options.session.workflowSkill;
}
