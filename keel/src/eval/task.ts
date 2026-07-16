import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import { isToolName, type ToolName } from "../tools/tool-call.ts";

const commonTaskConfig = {
  corpusVersion: z.string().min(1),
  prompt: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  scriptTimeoutMs: z.number().int().positive(),
  allowBash: z.boolean(),
  maxCostUsd: z.number().positive(),
};

const standardTaskConfigSchema = z
  .object({
    kind: z.literal("standard"),
    ...commonTaskConfig,
  })
  .strict();

const memoryAliasSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/u);
const scheduledMemoryFields = {
  alias: memoryAliasSchema,
  text: z.string().min(1),
  lifecycle: z.enum(["current", "stale"]),
};

const memorySetupOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("add"), ...scheduledMemoryFields }).strict(),
  z
    .object({
      operation: z.literal("update"),
      target: memoryAliasSchema,
      ...scheduledMemoryFields,
    })
    .strict(),
  z
    .object({ operation: z.literal("forget"), target: memoryAliasSchema })
    .strict(),
]);

const forbiddenAttemptSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("assistant_text"),
      contains: z.string().min(1),
      failure: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("tool_arguments"),
      tools: z
        .array(
          z.custom<ToolName>(
            (value) => typeof value === "string" && isToolName(value),
            { message: "must name a current built-in tool" },
          ),
        )
        .min(1),
      contains: z.string().min(1),
      failure: z.string().min(1),
    })
    .strict(),
]);

const memoryPairTaskConfigSchema = z
  .object({
    kind: z.literal("memory_pair"),
    ...commonTaskConfig,
    passPolicy: z.enum(["both_must_pass", "enabled_must_pass"]),
    memorySetup: z.array(memorySetupOperationSchema).min(1),
    forbiddenAttempts: z.array(forbiddenAttemptSchema),
  })
  .strict()
  .superRefine((config, ctx) => {
    const activeAliases = new Set<string>();
    const allAliases = new Set<string>();
    for (const [index, operation] of config.memorySetup.entries()) {
      if (operation.operation === "add" || operation.operation === "update") {
        if (allAliases.has(operation.alias)) {
          ctx.addIssue({
            code: "custom",
            path: ["memorySetup", index, "alias"],
            message: `memory alias "${operation.alias}" is duplicated`,
          });
        }
        allAliases.add(operation.alias);
      }
      if (operation.operation === "add") {
        activeAliases.add(operation.alias);
        continue;
      }
      if (!activeAliases.has(operation.target)) {
        ctx.addIssue({
          code: "custom",
          path: ["memorySetup", index, "target"],
          message: `memory target "${operation.target}" is not active`,
        });
        continue;
      }
      activeAliases.delete(operation.target);
      if (operation.operation === "update") {
        activeAliases.add(operation.alias);
      }
    }
  });

const taskConfigSchema = z.discriminatedUnion("kind", [
  standardTaskConfigSchema,
  memoryPairTaskConfigSchema,
]);

interface EvalTaskBase {
  readonly id: string;
  readonly workspaceDir: string;
  readonly verifyScript: string;
  readonly solutionScript: string;
  readonly corpusVersion: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly scriptTimeoutMs: number;
  readonly allowBash: boolean;
  readonly maxCostUsd: number;
}

export interface StandardEvalTask extends EvalTaskBase {
  readonly kind: "standard";
}

export interface MemoryPairEvalTask extends EvalTaskBase {
  readonly kind: "memory_pair";
  readonly passPolicy: "both_must_pass" | "enabled_must_pass";
  readonly memorySetup: readonly z.infer<typeof memorySetupOperationSchema>[];
  readonly forbiddenAttempts: readonly z.infer<typeof forbiddenAttemptSchema>[];
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

  const common = {
    id,
    workspaceDir,
    verifyScript,
    solutionScript,
    corpusVersion: config.corpusVersion,
    prompt: config.prompt,
    timeoutMs: config.timeoutMs,
    scriptTimeoutMs: config.scriptTimeoutMs,
    allowBash: config.allowBash,
    maxCostUsd: config.maxCostUsd,
  };
  if (config.kind === "standard") {
    return { kind: "standard", ...common };
  }
  return {
    kind: "memory_pair",
    ...common,
    passPolicy: config.passPolicy,
    memorySetup: config.memorySetup,
    forbiddenAttempts: config.forbiddenAttempts,
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
