import type { ModelMetadata } from "../core/model-metadata.ts";
import type { SkillDescriptor } from "./model.ts";

const UNKNOWN_MODEL_CATALOG_BUDGET_CHARS = 8_000;
const CATALOG_CONTEXT_FRACTION = 0.02;
const APPROXIMATE_CHARS_PER_TOKEN = 4;

export interface SkillCatalogExposure {
  readonly skills: readonly SkillDescriptor[];
  readonly total: number;
  readonly omitted: number;
  readonly budgetChars: number;
  readonly usedChars: number;
}

export function skillCatalogEntry(skill: SkillDescriptor): string {
  return `- name: ${JSON.stringify(skill.qualifiedName)}\n  description: ${JSON.stringify(skill.description)}\n  scope: ${JSON.stringify(skill.scope)}\n  path: ${JSON.stringify(skill.relativePath)}`;
}

export function skillCatalogBudgetChars(
  metadata: ModelMetadata | undefined,
): number {
  if (metadata?.status !== "known" || metadata.contextWindowTokens === null) {
    return UNKNOWN_MODEL_CATALOG_BUDGET_CHARS;
  }
  return Math.max(
    1,
    Math.floor(
      metadata.contextWindowTokens *
        CATALOG_CONTEXT_FRACTION *
        APPROXIMATE_CHARS_PER_TOKEN,
    ),
  );
}

function relevanceScore(skill: SkillDescriptor, request: string): number {
  const normalized = request.toLowerCase();
  const terms = normalized.split(/[^a-z0-9-]+/u).filter((term) => term !== "");
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  let score = skill.scope === "repo" ? 20 : 0;
  if (normalized.includes(skill.qualifiedName.toLowerCase())) score += 1_000;
  if (terms.includes(name)) score += 500;
  for (const term of terms) {
    if (term.length < 2) continue;
    if (name.includes(term)) score += 40;
    if (description.includes(term)) score += 10;
  }
  return score;
}

export function exposeSkillCatalog(options: {
  readonly skills: readonly SkillDescriptor[];
  readonly request: string;
  readonly modelMetadata?: ModelMetadata;
}): SkillCatalogExposure {
  const budgetChars = skillCatalogBudgetChars(options.modelMetadata);
  const ranked = options.skills.toSorted(
    (left, right) =>
      relevanceScore(right, options.request) -
        relevanceScore(left, options.request) ||
      left.rootPriority - right.rootPriority ||
      left.qualifiedName.localeCompare(right.qualifiedName) ||
      left.relativePath.localeCompare(right.relativePath),
  );
  const selected: SkillDescriptor[] = [];
  let usedChars = 0;
  for (const skill of ranked) {
    const entryChars = skillCatalogEntry(skill).length + 1;
    if (usedChars + entryChars > budgetChars) continue;
    selected.push(skill);
    usedChars += entryChars;
  }
  return {
    skills: selected,
    total: options.skills.length,
    omitted: options.skills.length - selected.length,
    budgetChars,
    usedChars,
  };
}

export function formatSkillCatalogDegradation(
  exposure: SkillCatalogExposure,
): string {
  if (exposure.omitted === 0) return "";
  return `Warning: skill catalog budget exposed ${exposure.skills.length} of ${exposure.total} implicit skills (${exposure.omitted} omitted; ${exposure.usedChars}/${exposure.budgetChars} characters). The model can search the full implicit catalog with skill_search.\n`;
}
