import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runReportSchema } from "../../../src/eval/report-schema.ts";
import { runCli } from "../../../src/testing/cli-harness.ts";
import {
  evalResultLine as resultLine,
  evalRunReport as runReport,
  writeEvalResultFile as writeResultFile,
} from "../../../src/testing/eval-fixtures.ts";

export {
  join,
  mkdir,
  mkdtemp,
  readFile,
  resultLine,
  rm,
  runCli,
  runReport,
  tmpdir,
  writeFile,
  writeResultFile,
  z,
};
export const resultLineSchema = z.object({
  schemaVersion: z.literal(1),
  timestamp: z.string(),
  keelVersion: z.string(),
  taskId: z.string(),
  trial: z.number().int().positive(),
  pass: z.boolean(),
  outcome: z.enum(["verified", "verify_failed", "timeout", "crashed"]),
  wallMs: z.number().nonnegative(),
  report: runReportSchema.optional(),
  transcriptPath: z.string().optional(),
});

export interface TaskFixture {
  readonly prompt: string;
  readonly files?: Record<string, string>;
  readonly verify: string;
  readonly solution?: string;
  readonly timeoutMs?: number;
  readonly scriptTimeoutMs?: number;
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

export async function createEvalDir(): Promise<{
  readonly root: string;
  readonly suiteDir: string;
  readonly outFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "keel-eval-"));
  const suiteDir = join(root, "tasks");
  await mkdir(suiteDir, { recursive: true });
  return { root, suiteDir, outFile: join(root, "results.jsonl") };
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

export const FIX_NOTE_TASK: TaskFixture = {
  prompt: "replace old with new in note.txt",
  files: { "note.txt": "hello old world\n" },
  verify: 'grep -q "hello new world" note.txt\n',
  solution: "printf 'hello new world\\n' > note.txt\n",
};
