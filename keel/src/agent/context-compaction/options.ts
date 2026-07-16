const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 2_000;
const DEFAULT_SUMMARY_INPUT_MAX_CHARS = 96_000;

export const MIN_SUMMARY_INPUT_MAX_CHARS = 1_000;

export interface ContextCompactionOptions {
  readonly contextWindowTokens?: number;
  readonly reserveTokens?: number;
  readonly keepRecentTokens?: number;
  readonly toolOutputMaxChars?: number;
  readonly summaryInputMaxChars?: number;
}

export interface ResolvedContextCompactionOptions {
  readonly contextWindowTokens?: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly toolOutputMaxChars: number;
  readonly summaryInputMaxChars: number;
}

export interface ContextCompactionRequestMetadata {
  readonly toolChoice?: "none";
  readonly allowBash?: boolean;
  readonly allowSkill?: boolean;
  readonly allowMemory?: boolean;
}

export interface ResolvedContextCompactionRequestMetadata {
  readonly toolChoice: "auto" | "none";
  readonly allowBash: boolean;
  readonly allowSkill: boolean;
  readonly allowMemory: boolean;
}

export function resolveContextCompactionOptions(
  options: ContextCompactionOptions | undefined,
): ResolvedContextCompactionOptions {
  const base = {
    reserveTokens: options?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: options?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    toolOutputMaxChars:
      options?.toolOutputMaxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS,
    summaryInputMaxChars:
      options?.summaryInputMaxChars ?? DEFAULT_SUMMARY_INPUT_MAX_CHARS,
  };
  if (options?.contextWindowTokens === undefined) {
    return base;
  }

  const summaryContextBudgetChars = Math.max(
    MIN_SUMMARY_INPUT_MAX_CHARS,
    Math.max(1, options.contextWindowTokens - base.reserveTokens) * 3,
  );
  return {
    ...base,
    contextWindowTokens: options.contextWindowTokens,
    summaryInputMaxChars: Math.min(
      base.summaryInputMaxChars,
      summaryContextBudgetChars,
    ),
  };
}

export function contextCompactionRequestTargetTokens(options: {
  readonly contextWindowTokens: number;
  readonly reserveTokens: number;
}): number {
  return Math.max(0, options.contextWindowTokens - options.reserveTokens);
}

export function resolvedRequestMetadata(
  metadata: ContextCompactionRequestMetadata | undefined,
): ResolvedContextCompactionRequestMetadata {
  const toolChoice = metadata?.toolChoice ?? "auto";
  return {
    toolChoice,
    allowBash: toolChoice === "none" ? false : metadata?.allowBash === true,
    allowSkill: toolChoice === "none" ? false : metadata?.allowSkill === true,
    allowMemory: toolChoice === "none" ? false : metadata?.allowMemory === true,
  };
}
