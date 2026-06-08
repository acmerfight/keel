import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { KeelError } from "./error.ts";
import { debugLog } from "./logger.ts";

export interface RecordLastEditCheckpointOptions {
  readonly workspace: string;
  readonly filePath: string;
  readonly beforeContent: string;
  readonly afterContent: string;
}

export interface RecordLastEditCheckpointResult {
  readonly written: boolean;
}

export type RestoreLastEditCheckpointResult =
  | {
      readonly status: "restored";
      readonly filePath: string;
    }
  | {
      readonly status: "none";
      readonly message: string;
    }
  | {
      readonly status: "blocked";
      readonly filePath: string;
      readonly message: string;
    };

interface GitWorkspace {
  readonly root: string;
  readonly checkpointPath: string;
}

const CHECKPOINT_METADATA_PATH = "keel/last-edit-checkpoint.json";

const gitOutputSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const checkpointSchema = z
  .object({
    version: z.literal(1),
    gitRoot: z.string().min(1),
    relativePath: z.string().min(1),
    beforeContent: z.string(),
    afterContent: z.string(),
    createdAt: z.string().min(1),
  })
  .strict();

type LastEditCheckpoint = z.infer<typeof checkpointSchema>;

function gitOutput(workspace: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync("git", [...args], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return gitOutputSchema.parse(output);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const childFromParent = relative(parent, child);
  return (
    childFromParent === "" ||
    (!childFromParent.startsWith("..") && !isAbsolute(childFromParent))
  );
}

function normalizeRelativePath(root: string, filePath: string): string | null {
  const absolutePath = realpathIfPossible(filePath);
  if (absolutePath === null) return null;
  if (!isInside(root, absolutePath)) return null;
  const relativePath = relative(root, absolutePath);
  if (relativePath === "") return null;
  return relativePath.split(sep).join("/");
}

function resolveCheckpointPath(workspace: string): string | null {
  return gitOutput(workspace, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    CHECKPOINT_METADATA_PATH,
  ]);
}

function findGitWorkspace(workspace: string): GitWorkspace | null {
  const rootOutput = gitOutput(workspace, ["rev-parse", "--show-toplevel"]);
  if (rootOutput === null) return null;
  const root = realpathSync(rootOutput);

  const checkpointPath = resolveCheckpointPath(workspace);
  if (checkpointPath === null) return null;

  return { root, checkpointPath };
}

function writeCheckpoint(
  checkpointPath: string,
  checkpoint: LastEditCheckpoint,
): void {
  mkdirSync(dirname(checkpointPath), { recursive: true });
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
}

function readCheckpoint(checkpointPath: string): LastEditCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch {
    throw new KeelError(
      "tool_unavailable",
      "undo failed: checkpoint is invalid",
    );
  }

  const result = checkpointSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeelError(
      "tool_unavailable",
      "undo failed: checkpoint is invalid",
    );
  }
  return result.data;
}

function readFileIfPossible(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function realpathIfPossible(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function skippedCheckpointRecord(
  options: RecordLastEditCheckpointOptions,
  error: string,
): RecordLastEditCheckpointResult {
  debugLog(
    `undo checkpoint write skipped: workspace=${options.workspace} filePath=${options.filePath} error=${error}`,
  );
  return { written: false };
}

export function recordLastEditCheckpoint(
  options: RecordLastEditCheckpointOptions,
): RecordLastEditCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedCheckpointRecord(options, "git workspace unavailable");
    }

    const relativePath = normalizeRelativePath(
      gitWorkspace.root,
      options.filePath,
    );
    if (relativePath === null) {
      return skippedCheckpointRecord(
        options,
        "file path unavailable or outside git root",
      );
    }

    writeCheckpoint(gitWorkspace.checkpointPath, {
      version: 1,
      gitRoot: gitWorkspace.root,
      relativePath,
      beforeContent: options.beforeContent,
      afterContent: options.afterContent,
      createdAt: new Date().toISOString(),
    });

    return { written: true };
  } catch (error) {
    return skippedCheckpointRecord(options, String(error));
  }
}

export function restoreLastEditCheckpoint(
  workspace: string,
): RestoreLastEditCheckpointResult {
  const gitWorkspace = findGitWorkspace(workspace);
  if (gitWorkspace === null || !existsSync(gitWorkspace.checkpointPath)) {
    return { status: "none", message: "Nothing to undo." };
  }

  const checkpoint = readCheckpoint(gitWorkspace.checkpointPath);
  if (checkpoint.gitRoot !== gitWorkspace.root) {
    return { status: "none", message: "Nothing to undo." };
  }

  const filePath = resolve(gitWorkspace.root, checkpoint.relativePath);
  if (!isInside(gitWorkspace.root, filePath)) {
    throw new KeelError(
      "tool_unavailable",
      "undo failed: checkpoint is invalid",
    );
  }

  const restorePath = realpathIfPossible(filePath);
  if (restorePath === null || !isInside(gitWorkspace.root, restorePath)) {
    return {
      status: "blocked",
      filePath: checkpoint.relativePath,
      message: `Cannot undo ${checkpoint.relativePath}: Refusing to overwrite user changes.`,
    };
  }

  const currentContent = readFileIfPossible(restorePath);
  if (currentContent !== checkpoint.afterContent) {
    return {
      status: "blocked",
      filePath: checkpoint.relativePath,
      message: `Cannot undo ${checkpoint.relativePath}: Refusing to overwrite user changes.`,
    };
  }

  writeFileSync(restorePath, checkpoint.beforeContent, "utf8");
  rmSync(gitWorkspace.checkpointPath, { force: true });
  return {
    status: "restored",
    filePath: checkpoint.relativePath,
  };
}
