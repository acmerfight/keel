import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import type { ToolResult } from "./types.ts";
import {
  isInsideWorkspace,
  resolveWorkspaceCreateTarget,
} from "./workspace-path.ts";

export function executeWrite(
  workspace: string,
  filePath: string,
  content: string,
): ToolResult {
  const { workspacePath, targetPath, parentPath } =
    resolveWorkspaceCreateTarget(workspace, filePath, "write");

  try {
    mkdirSync(parentPath, { recursive: true });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    if (code === "EEXIST" || code === "ENOTDIR") {
      throw new KeelError(
        "tool_not_directory",
        `write failed: parent path is not a directory: ${filePath}`,
      );
    }
    throw error;
  }

  const parentRealPath = realpathSync(parentPath);
  if (!isInsideWorkspace(workspacePath, parentRealPath)) {
    throw new KeelError(
      "tool_path_outside_workspace",
      `write failed: path is outside the workspace: ${filePath}`,
    );
  }

  try {
    writeFileSync(targetPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    if (code === "EEXIST") {
      throw new KeelError(
        "tool_file_exists",
        `write failed: file already exists: ${filePath}`,
      );
    }
    if (code === "ENOTDIR") {
      throw new KeelError(
        "tool_not_directory",
        `write failed: parent path is not a directory: ${filePath}`,
      );
    }
    throw error;
  }

  return { content: `Wrote ${filePath}` };
}
