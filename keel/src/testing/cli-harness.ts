import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dirname, "../cli/index.ts");
const DEFAULT_CLI_TIMEOUT_MS = 15_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: commandExitCode(error, child.exitCode),
        });
      },
    );
  });
}

function commandExitCode(
  error: { readonly code?: unknown } | null,
  exitCode: number | null,
): number {
  if (typeof error?.code === "number") return error.code;
  if (exitCode !== null) return exitCode;
  return error === null ? 0 : 1;
}

export function runCli(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return runCommand("node", ["--experimental-strip-types", CLI_PATH, ...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}

export function runCliProcess(
  args: readonly string[],
  options: {
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    readonly stdin?: "pipe" | "ignore";
  } = {},
) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const child = spawn(
    "node",
    ["--experimental-strip-types", CLI_PATH, ...args],
    {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env },
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    },
  );
  if (child.stdout === null || child.stderr === null) {
    throw new Error("CLI process harness requires piped stdout and stderr");
  }

  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });

  const result = new Promise<SpawnResult>((resolve) => {
    child.on("exit", (exitCode, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
      });
    });
  });

  return { child, result };
}

export async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  return await runCommand("git", args, { cwd });
}

export async function createGitWorkspace(
  prefix = "keel-git-",
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  await runGit(workspace, ["init", "--quiet", "--initial-branch=main"]);
  await runGit(workspace, ["config", "user.name", "Keel Test"]);
  await runGit(workspace, ["config", "user.email", "keel@example.com"]);
  return workspace;
}

export async function commitFile(
  workspace: string,
  path: string,
  content: string,
): Promise<void> {
  await writeFile(join(workspace, path), content, "utf8");
  await runGit(workspace, ["add", path]);
  await runGit(workspace, ["commit", "-m", `add ${path}`]);
}

export async function withGitWorkspace(
  action: (workspace: string) => Promise<void>,
  prefix = "keel-git-",
): Promise<void> {
  const workspace = await createGitWorkspace(prefix);
  try {
    await action(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
