import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";

const DEFAULT_TASK_TIMEOUT_MS = 300_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
const qualifiedSkillNamePattern =
  /^(?:repo|user|system|extra):(?:[a-z0-9]+(?:-[a-z0-9]+)*:)?[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const skillRoutingSchema = z.object({
  expectedActivations: z
    .array(z.string().regex(qualifiedSkillNamePattern))
    .max(3)
    .refine((names) => new Set(names).size === names.length, {
      message: "expected activations must be unique",
    }),
  pair: z
    .object({
      id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
      condition: z.enum(["with_skill", "without_skill"]),
    })
    .optional(),
});

const taskConfigSchema = z.object({
  prompt: z.string().min(1),
  timeoutMs: z.number().int().positive().default(DEFAULT_TASK_TIMEOUT_MS),
  scriptTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_SCRIPT_TIMEOUT_MS),
  allowBash: z.boolean().default(false),
  maxCostUsd: z.number().positive().optional(),
  skillRouting: skillRoutingSchema.optional(),
});

interface SkillRoutingExpectation {
  readonly expectedActivations: readonly string[];
  readonly pair?: {
    readonly id: string;
    readonly condition: "with_skill" | "without_skill";
  };
}

export interface EvalTask {
  readonly id: string;
  readonly workspaceDir: string;
  readonly verifyScript: string;
  readonly solutionScript: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly scriptTimeoutMs: number;
  readonly allowBash: boolean;
  readonly maxCostUsd?: number;
  readonly skillRouting?: SkillRoutingExpectation;
}

function leaksSkillAnswer(
  prompt: string,
  expectedActivations: readonly string[],
): boolean {
  const mentionsExpectedPackage = expectedActivations.some((qualifiedName) => {
    const name = qualifiedName.slice(qualifiedName.lastIndexOf(":") + 1);
    return new RegExp(`(?:^|[^a-z0-9-])${name}(?=$|[^a-z0-9-])`, "iu").test(
      prompt,
    );
  });
  return (
    /\bskills?\b/iu.test(prompt) ||
    /(?:^|\s)\$[a-z]/iu.test(prompt) ||
    /(?:^|\s)--skill(?:=|\s)/iu.test(prompt) ||
    /(?:^|\s)\/skill(?:\s|$)/iu.test(prompt) ||
    mentionsExpectedPackage
  );
}

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
  if (
    parsed.data.skillRouting !== undefined &&
    leaksSkillAnswer(
      parsed.data.prompt,
      parsed.data.skillRouting.expectedActivations,
    )
  ) {
    throw new Error(
      `eval task "${id}" leaks a Skill answer hint in prompt; routing gold must remain private.`,
    );
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

  return {
    id,
    workspaceDir,
    verifyScript,
    solutionScript,
    prompt: config.prompt,
    timeoutMs: config.timeoutMs,
    scriptTimeoutMs: config.scriptTimeoutMs,
    allowBash: config.allowBash,
    ...(config.maxCostUsd !== undefined
      ? { maxCostUsd: config.maxCostUsd }
      : {}),
    ...(config.skillRouting !== undefined
      ? {
          skillRouting: {
            expectedActivations: [...config.skillRouting.expectedActivations],
            ...(config.skillRouting.pair !== undefined
              ? { pair: { ...config.skillRouting.pair } }
              : {}),
          },
        }
      : {}),
  };
}

function validateSkillRoutingPairs(tasks: readonly EvalTask[]): void {
  const pairs = new Map<string, EvalTask[]>();
  for (const task of tasks) {
    const pair = task.skillRouting?.pair;
    if (pair === undefined) continue;
    const group = pairs.get(pair.id) ?? [];
    group.push(task);
    pairs.set(pair.id, group);
  }

  for (const [pairId, pairTasks] of pairs) {
    const withSkill = pairTasks.filter(
      (task) => task.skillRouting?.pair?.condition === "with_skill",
    );
    const withoutSkill = pairTasks.filter(
      (task) => task.skillRouting?.pair?.condition === "without_skill",
    );
    if (withSkill.length !== 1 || withoutSkill.length !== 1) {
      throw new Error(
        `eval Skill pair "${pairId}" requires exactly one with_skill task and one without_skill task`,
      );
    }
    const withSkillTask = withSkill[0];
    const withoutSkillTask = withoutSkill[0];
    if (withSkillTask === undefined || withoutSkillTask === undefined) {
      throw new Error(`eval Skill pair "${pairId}" is incomplete`);
    }
    if (withSkillTask.prompt !== withoutSkillTask.prompt) {
      throw new Error(
        `eval Skill pair "${pairId}" must use the same natural prompt in both conditions`,
      );
    }
    if (
      withSkillTask.skillRouting?.expectedActivations.length === 0 ||
      withoutSkillTask.skillRouting?.expectedActivations.length !== 0
    ) {
      throw new Error(
        `eval Skill pair "${pairId}" requires expected activations only in the with_skill condition`,
      );
    }
    const withSkillContract = pairedTaskContract(withSkillTask);
    const withoutSkillContract = pairedTaskContract(withoutSkillTask);
    if (withSkillContract !== withoutSkillContract) {
      throw new Error(
        `eval Skill pair "${pairId}" must differ only by packages under workspace/.agents/skills`,
      );
    }
  }
}

function workspaceEntries(
  directory: string,
  relativeDirectory = "",
): readonly string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const relativePath =
      relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
    if (relativePath === ".agents/skills") continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...workspaceEntries(absolutePath, relativePath));
      continue;
    }
    if (entry.isSymbolicLink()) {
      entries.push(`${relativePath}\0link\0${readlinkSync(absolutePath)}`);
      continue;
    }
    entries.push(
      `${relativePath}\0file\0${readFileSync(absolutePath).toString("base64")}`,
    );
  }
  return entries;
}

function pairedTaskContract(task: EvalTask): string {
  return JSON.stringify({
    timeoutMs: task.timeoutMs,
    scriptTimeoutMs: task.scriptTimeoutMs,
    allowBash: task.allowBash,
    maxCostUsd: task.maxCostUsd ?? null,
    workspace: workspaceEntries(task.workspaceDir),
    verify: readFileSync(task.verifyScript, "utf8"),
    solution: readFileSync(task.solutionScript, "utf8"),
  });
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

  const tasks = taskIds.map((id) => loadTask(absoluteSuiteDir, id));
  validateSkillRoutingPairs(tasks);
  return tasks;
}
