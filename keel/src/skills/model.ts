export class WorkflowSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSkillError";
  }
}

export interface WorkflowSkill {
  readonly relativePath: string;
  readonly name: string;
  readonly resourcePaths: readonly string[];
  readonly content: string;
}

export interface SkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly digest: string;
}

export interface SkillCatalogWarning {
  readonly name: string;
  readonly message: string;
}

export interface ProjectSkillCatalog {
  readonly skills: readonly SkillDescriptor[];
  readonly warnings: readonly SkillCatalogWarning[];
  readonly load: (name: string) => WorkflowSkill;
}

export interface SkillActivationRecord {
  readonly name: string;
  readonly relativePath: string;
  readonly trigger: "model_selected";
}

export interface SkillActivationCapability {
  readonly activate: (name: string) => {
    readonly skill: WorkflowSkill;
    readonly record: SkillActivationRecord;
  };
}
