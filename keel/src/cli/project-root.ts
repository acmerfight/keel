import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

export function projectRoot(workspace: string): string {
  const resolvedWorkspace = resolve(workspace);
  let current = resolvedWorkspace;
  while (true) {
    if (pathExists(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolvedWorkspace;
    }
    current = parent;
  }
}
