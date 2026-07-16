import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProviderId } from "../../../src/core/provider-id.ts";
import {
  type EvalResultLine,
  evalResultLineSchema as resultLineSchema,
} from "../../../src/eval/result.ts";
import { runEvalCommand as runEvalCommandUnderTest } from "../../../src/eval/run.ts";

export {
  isAbsolute,
  join,
  mkdir,
  mkdtemp,
  readFile,
  resultLineSchema,
  rm,
  tmpdir,
  writeFile,
};

interface TestEvalCommandArgs {
  readonly suiteDir: string;
  readonly outFile: string;
  readonly trials: number;
  readonly taskId?: string;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly check: boolean;
  readonly cliEntry: string;
  readonly transcriptDir?: string;
}

export function runEvalCommand(args: TestEvalCommandArgs): Promise<number> {
  const common = {
    suiteDir: args.suiteDir,
    outFile: args.outFile,
    trials: args.trials,
    ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    cliEntry: args.cliEntry,
    ...(args.transcriptDir !== undefined
      ? { transcriptDir: args.transcriptDir }
      : {}),
  };
  if (args.check) {
    return runEvalCommandUnderTest({ ...common, check: true, selection: null });
  }
  return runEvalCommandUnderTest({
    ...common,
    check: false,
    selection: {
      providerId: args.providerId ?? "fake",
      model: args.model ?? "fake",
    },
  });
}

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
      kind: "standard",
      corpusVersion: "test-v1",
      prompt: fixture.prompt,
      timeoutMs: fixture.timeoutMs ?? 300_000,
      scriptTimeoutMs: fixture.scriptTimeoutMs ?? 60_000,
      allowBash: fixture.allowBash ?? false,
      maxCostUsd: fixture.maxCostUsd ?? 0.05,
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
): Promise<readonly EvalResultLine[]> {
  const raw = await readFile(outFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => resultLineSchema.parse(JSON.parse(line)));
}

export const CLI_ENTRY = join(process.cwd(), "src/cli/index.ts");
export const REPORT_CONTENT_ENV = "REPORT_CONTENT";
export const FIX_NOTE_TASK: TaskFixture = {
  prompt: "replace old with new in note.txt",
  files: { "note.txt": "hello old world\n" },
  verify: 'grep -q "hello new world" note.txt\n',
  solution: "printf 'hello new world\\n' > note.txt\n",
};
export const VALID_REPORT = {
  schemaVersion: 15,
  tasks: [
    {
      ordinal: 1,
      trigger: "user_prompt",
      humanInterventionCount: 0,
      agentRuns: [
        {
          ordinal: 1,
          trigger: "user_prompt",
          humanInterventionCount: 0,
          agentLoopTurns: 1,
          providerRetries: [],
          contextCompactions: [],
          stopReason: "completed",
        },
      ],
      outcome: "completed",
    },
  ],
  humanInterventionCount: 0,
  modelOperations: [
    {
      ordinal: 1,
      owner: { type: "agent_run", taskOrdinal: 1, agentRunOrdinal: 1 },
      purpose: "agent_turn",
      provider: "fake",
      model: "fake",
      outcome: "completed",
      providerRequestAttempts: [
        {
          ordinal: 1,
          outcome: "completed",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
          costUsd: 0,
        },
      ],
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      costUsd: 0,
    },
  ],
  modelOperationCount: 1,
  providerRequestAttemptCount: 1,
  modelsUsed: [{ provider: "fake", model: "fake" }],
  usageByModel: [
    {
      provider: "fake",
      model: "fake",
      agentLoopTurns: 1,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      costUsd: 0,
    },
  ],
  agentLoopTurns: 1,
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
  activeSkills: [],
  skillCatalog: {
    exposed: 0,
    omitted: 0,
    total: 0,
    budgetChars: 8000,
    usedChars: 0,
  },
  skillPolicy: { mode: "enabled", disabledPackages: 0 },
  undoProtection: {
    status: "not_applicable",
    checkpointsWritten: 0,
    failures: [],
    latestCheckpoint: null,
  },
  memory: {
    enabled: false,
    scope: null,
    loadedIds: [],
    loadedEntries: [],
    renderedBytes: 0,
    estimatedTokens: 0,
    operations: [],
  },
};
