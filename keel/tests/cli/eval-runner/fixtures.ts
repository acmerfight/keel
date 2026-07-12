import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { z } from "zod";
import { runEvalCommand } from "../../../src/eval/run.ts";

export {
  isAbsolute,
  join,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  runEvalCommand,
  tmpdir,
  writeFile,
  z,
};
export const resultLineSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  trial: z.number().int().positive(),
  pass: z.boolean(),
  outcome: z.enum(["verified", "verify_failed", "timeout", "crashed"]),
  report: z
    .object({
      schemaVersion: z.literal(5),
      modelsUsed: z.array(
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      ),
      usageByModel: z.array(
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      ),
      contextCompactions: z.array(z.unknown()),
      skillActivations: z.array(z.unknown()),
      costOvershootUsd: z.number().nonnegative(),
    })
    .optional(),
  transcriptPath: z.string().optional(),
});

export interface TaskFixture {
  readonly prompt: string;
  readonly files?: Record<string, string>;
  readonly verify: string;
  readonly solution?: string;
  readonly timeoutMs?: number;
  readonly scriptTimeoutMs?: number;
  readonly allowBash?: boolean;
  readonly maxCostUsd?: number;
}

export async function createEvalDir(): Promise<{
  readonly root: string;
  readonly suiteDir: string;
  readonly outFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "keel-eval-runner-"));
  const suiteDir = join(root, "tasks");
  await mkdir(suiteDir, { recursive: true });
  return { root, suiteDir, outFile: join(root, "results.jsonl") };
}

export async function createTask(
  suiteDir: string,
  id: string,
  fixture: TaskFixture,
): Promise<void> {
  const taskDir = join(suiteDir, id);
  await mkdir(join(taskDir, "workspace"), { recursive: true });
  await writeFile(
    join(taskDir, "task.json"),
    JSON.stringify({
      prompt: fixture.prompt,
      ...(fixture.timeoutMs !== undefined
        ? { timeoutMs: fixture.timeoutMs }
        : {}),
      ...(fixture.scriptTimeoutMs !== undefined
        ? { scriptTimeoutMs: fixture.scriptTimeoutMs }
        : {}),
      ...(fixture.allowBash !== undefined
        ? { allowBash: fixture.allowBash }
        : {}),
      ...(fixture.maxCostUsd !== undefined
        ? { maxCostUsd: fixture.maxCostUsd }
        : {}),
    }),
    "utf8",
  );
  for (const [name, content] of Object.entries(fixture.files ?? {})) {
    await writeFile(join(taskDir, "workspace", name), content, "utf8");
  }
  await writeFile(join(taskDir, "verify.sh"), fixture.verify, "utf8");
  await writeFile(
    join(taskDir, "solution.sh"),
    fixture.solution ?? "exit 1\n",
    "utf8",
  );
}

export async function readResultLines(
  outFile: string,
): Promise<readonly z.infer<typeof resultLineSchema>[]> {
  const raw = await readFile(outFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => resultLineSchema.parse(JSON.parse(line)));
}

export const CLI_ENTRY = join(process.cwd(), "src/cli/index.ts");
export const KEEL_PROVIDER_ENV = "KEEL_PROVIDER";
export const REPORT_CONTENT_ENV = "REPORT_CONTENT";
export const FIX_NOTE_TASK: TaskFixture = {
  prompt: "replace old with new in note.txt",
  files: { "note.txt": "hello old world\n" },
  verify: 'grep -q "hello new world" note.txt\n',
  solution: "printf 'hello new world\\n' > note.txt\n",
};
export const VALID_REPORT = {
  schemaVersion: 5,
  modelsUsed: [{ provider: "fake", model: "fake" }],
  usageByModel: [
    {
      provider: "fake",
      model: "fake",
      turns: 1,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      costUsd: 0,
    },
  ],
  turns: 1,
  stopReason: "completed",
  usage: {
    inputTokens: 1,
    cachedInputTokens: 0,
    uncachedInputTokens: 1,
    outputTokens: 1,
  },
  durationMs: 1,
  costUsd: 0,
  costOvershootUsd: 0,
  contextCompactions: [],
  skillActivations: [],
};

export let previousKeelProvider: string | undefined;

beforeEach(() => {
  previousKeelProvider = process.env[KEEL_PROVIDER_ENV];
  process.env[KEEL_PROVIDER_ENV] = "fake";
});

afterEach(() => {
  if (previousKeelProvider === undefined) {
    delete process.env[KEEL_PROVIDER_ENV];
    return;
  }
  process.env[KEEL_PROVIDER_ENV] = previousKeelProvider;
});
