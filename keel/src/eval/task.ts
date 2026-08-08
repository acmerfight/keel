import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";

const DEFAULT_TASK_TIMEOUT_MS = 300_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
const delegationPolicySchema = z.enum(["require_one", "forbid", "at_most_one"]);
type EvalDelegationPolicy = z.infer<typeof delegationPolicySchema>;

const standardTaskConfigSchema = z
  .object({
    kind: z.literal("standard"),
    prompt: z.string().min(1),
    timeoutMs: z.number().int().positive().default(DEFAULT_TASK_TIMEOUT_MS),
    scriptTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_SCRIPT_TIMEOUT_MS),
    allowBash: z.boolean().default(false),
    maxCostUsd: z.number().positive().optional(),
    experimentalAgents: z.boolean().default(false),
    delegationPolicy: delegationPolicySchema.optional(),
  })
  .strict();

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

const taskConfigSchema = z.discriminatedUnion("kind", [
  standardTaskConfigSchema,
  memoryPairTaskConfigSchema,
]);

interface EvalTaskBase {
  readonly id: string;
  readonly workspaceDir: string;
  readonly verifyScript: string;
  readonly solutionScript: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly scriptTimeoutMs: number;
  readonly allowBash: boolean;
  readonly experimentalAgents: boolean;
  readonly delegationPolicy?: EvalDelegationPolicy;
}

export interface StandardEvalTask extends EvalTaskBase {
  readonly kind: "standard";
  readonly maxCostUsd?: number;
}

export interface MemoryPairEvalTask extends EvalTaskBase {
  readonly kind: "memory_pair";
  readonly maxCostUsd: number;
  readonly memory: string;
}

export type EvalTask = StandardEvalTask | MemoryPairEvalTask;

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
      experimentalAgents: false,
      maxCostUsd: config.maxCostUsd,
      memory: config.memory,
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
    experimentalAgents: config.experimentalAgents,
    ...(config.delegationPolicy !== undefined
      ? { delegationPolicy: config.delegationPolicy }
      : {}),
    ...(config.maxCostUsd === undefined
      ? {}
      : { maxCostUsd: config.maxCostUsd }),
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
