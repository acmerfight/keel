import { readFileSync, statSync, writeFileSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import { recordLastEditCheckpoint } from "../core/git.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";
import { resolveWorkspaceTarget } from "./workspace-path.ts";

function countLines(content: string): number {
  let lineCount = 1;
  for (const character of content) {
    if (character === "\n") {
      lineCount++;
    }
  }
  return lineCount;
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let start = 0;
  while (true) {
    const index = content.indexOf(search, start);
    if (index < 0) return count;
    count++;
    start = index + search.length;
  }
}

export function executeEdit(
  workspace: string,
  filePath: string,
  oldString: string,
  newString: string,
): ToolResult {
  if (oldString === "") {
    throw new KeelError(
      "tool_empty_old_string",
      "edit failed: old string is empty",
      "Provide the exact text to replace. Use read to find the target text first.",
    );
  }

  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    filePath,
    "edit",
  );

  const targetStat = statSync(targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (
    projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(targetPath, targetIsDirectory)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `edit failed: ignored path: ${filePath}`,
      "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
    );
  }

  const content = readFileSync(targetPath, "utf8");
  const firstMatch = content.indexOf(oldString);
  if (firstMatch < 0) {
    const lineCount = countLines(content);
    throw new KeelError(
      "tool_old_string_not_found",
      `edit failed: old string not found in ${filePath} (${lineCount} lines)`,
      `Use read(path: "${filePath}") to view the current file content, then retry edit with the exact text from the file.`,
    );
  }

  const secondMatch = content.indexOf(oldString, firstMatch + oldString.length);
  if (secondMatch >= 0) {
    const matchCount = countOccurrences(content, oldString);
    throw new KeelError(
      "tool_old_string_not_unique",
      `edit failed: old string appears ${matchCount} times in ${filePath}`,
      "Include more surrounding context in oldString to make the match unique, or target a specific occurrence.",
    );
  }

  const updated =
    content.slice(0, firstMatch) +
    newString +
    content.slice(firstMatch + oldString.length);
  writeFileSync(targetPath, updated, "utf8");
  recordLastEditCheckpoint({
    workspace: workspacePath,
    filePath: targetPath,
    beforeContent: content,
    afterContent: updated,
  });

  return { content: `Edited ${filePath}` };
}
