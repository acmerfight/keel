import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  type DelegatingAgentPolicy,
  delegatingAgentPolicies,
} from "../core/agent-policy.ts";
import { errorMessage } from "../core/error.ts";
import { reasoningEfforts } from "../core/model-metadata.ts";
import { providerIds } from "../core/provider-id.ts";

const DEFAULT_TASK_TIMEOUT_MS = 300_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
export const evalDelegationPolicies = [
  "require_one",
  "require_multiple",
  "require_any",
  "forbid",
  "at_most_one",
] as const;
const delegationPolicySchema = z.enum(evalDelegationPolicies);
export type EvalDelegationPolicy = z.infer<typeof delegationPolicySchema>;

export const evalDelegationExpectationSchema = z
  .object({
    profile: z.string().min(1),
    providerId: z.enum(providerIds),
    model: z.string().trim().min(1),
    effort: z.enum(reasoningEfforts).nullable(),
  })
  .strict();

export type EvalDelegationExpectation = z.infer<
  typeof evalDelegationExpectationSchema
>;

const standardTaskBaseShape = {
  kind: z.literal("standard"),
  prompt: z.string().min(1),
  timeoutMs: z.number().int().positive().default(DEFAULT_TASK_TIMEOUT_MS),
  scriptTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_SCRIPT_TIMEOUT_MS),
  allowBash: z.boolean().default(false),
};

const standardTaskConfigSchema = z.discriminatedUnion("agentPolicy", [
  z
    .object({
      ...standardTaskBaseShape,
      agentPolicy: z.literal("off"),
      maxCostUsd: z.number().positive().optional(),
      delegationPolicy: z.never().optional(),
      delegationExpectation: z.never().optional(),
    })
    .strict(),
  z
    .object({
      ...standardTaskBaseShape,
      agentPolicy: z.literal("explicit"),
      maxCostUsd: z.number().positive(),
      delegationPolicy: delegationPolicySchema.optional(),
      delegationExpectation: evalDelegationExpectationSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...standardTaskBaseShape,
      agentPolicy: z.literal("auto"),
      maxCostUsd: z.number().positive(),
      delegationPolicy: delegationPolicySchema.optional(),
      delegationExpectation: evalDelegationExpectationSchema.optional(),
    })
    .strict(),
]);

const memoryPairTaskConfigSchema = z
  .object({
    kind: z.literal("memory_pair"),
    prompt: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    scriptTimeoutMs: z.number().int().positive(),
    allowBash: z.boolean(),
    maxCostUsd: z.number().positive(),
    memory: z.string().min(1),
  })
  .strict();

const delegationPairTaskConfigSchema = z
  .object({
    kind: z.literal("delegation_pair"),
    prompt: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    scriptTimeoutMs: z.number().int().positive(),
    allowBash: z.boolean(),
    maxCostUsd: z.number().positive(),
    agentPolicy: z.enum(delegatingAgentPolicies),
    delegationPolicy: delegationPolicySchema,
  })
  .strict();

const taskConfigInputSchema = z.discriminatedUnion("kind", [
  standardTaskConfigSchema,
  memoryPairTaskConfigSchema,
  delegationPairTaskConfigSchema,
]);
const taskConfigSchema = z
  .preprocess((input) => {
    if (
      typeof input === "object" &&
      input !== null &&
      "kind" in input &&
      input.kind === "standard" &&
      !("agentPolicy" in input)
    ) {
      return { ...input, agentPolicy: "off" };
    }
    return input;
  }, taskConfigInputSchema)
  .superRefine((config, ctx) => {
    if (
      config.kind === "standard" &&
      config.agentPolicy !== "off" &&
      config.delegationExpectation !== undefined &&
      config.delegationPolicy === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["delegationPolicy"],
        message: "is required when delegationExpectation is configured",
      });
    }
  });

interface EvalTaskBase {
  readonly id: string;
  readonly workspaceDir: string;
  readonly verifyScript: string;
  readonly solutionScript: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly scriptTimeoutMs: number;
  readonly allowBash: boolean;
}

interface StandardEvalTaskBase extends EvalTaskBase {
  readonly kind: "standard";
  readonly maxCostUsd?: number;
}

export type StandardEvalTask = StandardEvalTaskBase &
  (
    | {
        readonly agentPolicy: "off";
        readonly delegationPolicy?: never;
      }
    | ({
        readonly agentPolicy: DelegatingAgentPolicy;
        readonly maxCostUsd: number;
      } & (
        | {
            readonly delegationPolicy?: never;
            readonly delegationExpectation?: never;
          }
        | {
            readonly delegationPolicy: EvalDelegationPolicy;
            readonly delegationExpectation?: EvalDelegationExpectation;
          }
      ))
  );

export interface MemoryPairEvalTask extends EvalTaskBase {
  readonly kind: "memory_pair";
  readonly maxCostUsd: number;
  readonly memory: string;
}

export interface DelegationPairEvalTask extends EvalTaskBase {
  readonly kind: "delegation_pair";
  readonly maxCostUsd: number;
  readonly agentPolicy: DelegatingAgentPolicy;
  readonly delegationPolicy: EvalDelegationPolicy;
}

export type EvalTask =
  | StandardEvalTask
  | MemoryPairEvalTask
  | DelegationPairEvalTask;

function parseTaskConfig(
  id: string,
  configPath: string,
): z.infer<typeof taskConfigSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const detail = errorMessage(error);
    throw new Error(`eval task "${id}" has unreadable task.json: ${detail}`);
  }

  const parsed = taskConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`eval task "${id}" has invalid task.json: ${issues}`);
  }
  return parsed.data;
}

function loadTask(suiteDir: string, id: string): EvalTask {
  const dir = join(suiteDir, id);
  const configPath = join(dir, "task.json");
  if (!existsSync(configPath)) {
    throw new Error(`eval task "${id}" is missing task.json`);
  }
  const config = parseTaskConfig(id, configPath);

  const workspaceDir = join(dir, "workspace");
  if (!existsSync(workspaceDir) || !statSync(workspaceDir).isDirectory()) {
    throw new Error(`eval task "${id}" is missing workspace/ directory`);
  }

  const verifyScript = join(dir, "verify.sh");
  if (!existsSync(verifyScript)) {
    throw new Error(`eval task "${id}" is missing verify.sh`);
  }

  // A reference solution proves the task is solvable and the verifier is
  // correctly configured, so it is required (the Terminal-Bench oracle
  // pattern). `keel eval --check` replays it through the verifier.
  const solutionScript = join(dir, "solution.sh");
  if (!existsSync(solutionScript)) {
    throw new Error(`eval task "${id}" is missing solution.sh`);
  }

  if (config.kind === "memory_pair") {
    return {
      kind: "memory_pair",
      id,
      workspaceDir,
      verifyScript,
      solutionScript,
      prompt: config.prompt,
      timeoutMs: config.timeoutMs,
      scriptTimeoutMs: config.scriptTimeoutMs,
      allowBash: config.allowBash,
      maxCostUsd: config.maxCostUsd,
      memory: config.memory,
    };
  }
  if (config.kind === "delegation_pair") {
    return {
      kind: "delegation_pair",
      id,
      workspaceDir,
      verifyScript,
      solutionScript,
      prompt: config.prompt,
      timeoutMs: config.timeoutMs,
      scriptTimeoutMs: config.scriptTimeoutMs,
      allowBash: config.allowBash,
      maxCostUsd: config.maxCostUsd,
      agentPolicy: config.agentPolicy,
      delegationPolicy: config.delegationPolicy,
    };
  }
  if (config.agentPolicy === "off") {
    return {
      kind: "standard",
      id,
      workspaceDir,
      verifyScript,
      solutionScript,
      prompt: config.prompt,
      timeoutMs: config.timeoutMs,
      scriptTimeoutMs: config.scriptTimeoutMs,
      allowBash: config.allowBash,
      agentPolicy: "off",
      ...(config.maxCostUsd === undefined
        ? {}
        : { maxCostUsd: config.maxCostUsd }),
    };
  }
  if (config.delegationPolicy !== undefined) {
    return {
      kind: "standard",
      id,
      workspaceDir,
      verifyScript,
      solutionScript,
      prompt: config.prompt,
      timeoutMs: config.timeoutMs,
      scriptTimeoutMs: config.scriptTimeoutMs,
      allowBash: config.allowBash,
      agentPolicy: config.agentPolicy,
      maxCostUsd: config.maxCostUsd,
      delegationPolicy: config.delegationPolicy,
      ...(config.delegationExpectation !== undefined
        ? { delegationExpectation: config.delegationExpectation }
        : {}),
    };
  }
  return {
    kind: "standard",
    id,
    workspaceDir,
    verifyScript,
    solutionScript,
    prompt: config.prompt,
    timeoutMs: config.timeoutMs,
    scriptTimeoutMs: config.scriptTimeoutMs,
    allowBash: config.allowBash,
    agentPolicy: config.agentPolicy,
    maxCostUsd: config.maxCostUsd,
  };
}

export function loadEvalTasks(suiteDir: string): readonly EvalTask[] {
  const absoluteSuiteDir = resolve(suiteDir);
  if (
    !existsSync(absoluteSuiteDir) ||
    !statSync(absoluteSuiteDir).isDirectory()
  ) {
    throw new Error(`eval suite directory not found: ${suiteDir}`);
  }

  const taskIds = readdirSync(absoluteSuiteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (taskIds.length === 0) {
    throw new Error(`eval suite has no task directories: ${suiteDir}`);
  }

  return taskIds.map((id) => loadTask(absoluteSuiteDir, id));
}
