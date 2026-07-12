export class WorkflowSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSkillError";
  }
}

export type SkillScope = "repo" | "user" | "system" | "extra";
export type SkillActivationPolicy = "implicit" | "explicit";

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
  readonly load: (lookup: string) => WorkflowSkill;
  readonly loadImplicit: (lookup: string) => WorkflowSkill;
  readonly search: (
    query: string,
    limit?: number,
  ) => readonly SkillDescriptor[];
  readonly readResource: (lookup: string, path: string) => string;
}

export interface SkillActivationRecord {
  readonly name: string;
  readonly relativePath: string;
  readonly trigger: "model_selected" | "user_explicit";
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
  readonly expose: (skills: readonly SkillDescriptor[]) => void;
  readonly registerExplicit: (skills: readonly WorkflowSkill[]) => void;
  readonly search: (query: string) => readonly SkillDescriptor[];
  readonly readResource: (lookup: string, path: string) => string;
  readonly activate: (name: string) => {
    readonly skill: WorkflowSkill;
    readonly record: SkillActivationRecord;
  };
}
