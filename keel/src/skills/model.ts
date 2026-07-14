import type { SkillPackageAudit } from "./audit.ts";

export class WorkflowSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSkillError";
  }
}

export type SkillScope = "repo" | "user" | "system" | "extra";
export type SkillActivationPolicy = "implicit" | "explicit";

export const MODEL_SELECTED_SKILL_ACTIVATIONS_PER_TURN = 3;

export interface WorkflowSkill {
  readonly id: string;
  readonly packageId: string;
  readonly qualifiedName: string;
  readonly scope: SkillScope;
  readonly digest: string;
  readonly relativePath: string;
  readonly name: string;
  readonly resourcePaths: readonly string[];
  readonly content: string;
}

export interface SkillDescriptor {
  readonly id: string;
  readonly packageId: string;
  readonly rootKey: string;
  readonly rootPriority: number;
  readonly qualifiedName: string;
  readonly scope: SkillScope;
  readonly activationPolicy: SkillActivationPolicy;
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly digest: string;
}

export interface SkillCatalogWarning {
  readonly name: string;
  readonly message: string;
}

export interface SkillCatalog {
  readonly skills: readonly SkillDescriptor[];
  readonly implicitSkills: readonly SkillDescriptor[];
  readonly warnings: readonly SkillCatalogWarning[];
  readonly audits: readonly SkillPackageAudit[];
  readonly load: (lookup: string) => WorkflowSkill;
  readonly loadImplicit: (lookup: string) => WorkflowSkill;
  readonly loadPackage: (packageId: string) => WorkflowSkill | undefined;
  readonly search: (
    query: string,
    limit?: number,
  ) => readonly SkillDescriptor[];
  readonly readResource: (lookup: string, path: string) => string;
  readonly readPackageResource: (
    packageId: string,
    digest: string,
    path: string,
  ) => string;
}

export interface SkillActivationRecord {
  readonly name: string;
  readonly relativePath: string;
  readonly trigger: "model_selected" | "user_explicit";
}

type SkillActivationTrigger = "model_selected" | "user_explicit";

export interface SkillActivation {
  readonly descriptorId: string;
  readonly packageId: string;
  readonly qualifiedName: string;
  readonly scope: SkillScope;
  readonly name: string;
  readonly relativePath: string;
  readonly resourcePaths: readonly string[];
  readonly digest: string;
  readonly trigger: SkillActivationTrigger;
  readonly args: string;
  readonly contentSnapshot: string;
  readonly activatedAt: string;
}

export interface SkillLifecycleState {
  readonly skillActivations: readonly SkillActivation[];
  readonly activeSkillIds: readonly string[];
}

type ActiveSkillDiskStatus = "current" | "changed_on_disk" | "missing_on_disk";

export interface ActiveSkillStatus {
  readonly activation: SkillActivation;
  readonly diskStatus: ActiveSkillDiskStatus;
}

export interface SkillActivationResult {
  readonly activation: SkillActivation;
  readonly skill: WorkflowSkill;
  readonly newlyActivated: boolean;
  readonly record?: SkillActivationRecord;
}

export function explicitSkillActivationRecord(
  skill: WorkflowSkill,
): SkillActivationRecord {
  return {
    name: skill.qualifiedName,
    relativePath: skill.relativePath,
    trigger: "user_explicit",
  };
}

export interface SkillActivationCapability {
  readonly beginTurn: () => void;
  readonly expose: (skills: readonly SkillDescriptor[]) => void;
  readonly registerExplicit: (
    skills: readonly WorkflowSkill[],
  ) => readonly SkillActivation[];
  readonly activateExplicit: (
    skill: WorkflowSkill,
    args: string,
  ) => SkillActivationResult;
  readonly search: (query: string) => readonly SkillDescriptor[];
  readonly readResource: (lookup: string, path: string) => string;
  readonly activate: (name: string) => SkillActivationResult;
  readonly deactivate: (lookup: string) => SkillActivation;
  readonly reload: (lookup: string) => SkillActivationResult;
  readonly active: () => readonly SkillActivation[];
  readonly activeStatuses: () => readonly ActiveSkillStatus[];
  readonly state: () => SkillLifecycleState;
  readonly restore: (state: SkillLifecycleState) => void;
}
