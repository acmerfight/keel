import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import type { BashProjectApprovalGrant } from "../permissions/bash.ts";
import { escapeApprovalText } from "./bash-approval-text.ts";
import { sessionHome } from "./session-store.ts";

interface BashProjectApprovalRuntime {
  readonly env: (key: string) => string | undefined;
}

const bashProjectApprovalGrantSchema = z
  .object({
    projectRoot: z.string().min(1),
    cwd: z.string().min(1),
    argvPrefix: z.array(z.string().min(1)).min(1),
  })
  .strict();
const bashProjectApprovalsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    grants: z.array(bashProjectApprovalGrantSchema),
  })
  .strict();

type BashProjectApprovalsFile = z.infer<typeof bashProjectApprovalsFileSchema>;
type BashProjectApprovalsFileGrant = BashProjectApprovalsFile["grants"][number];

export class BashProjectApprovalsError extends Error {}

function bashProjectApprovalsPath(runtime: BashProjectApprovalRuntime): string {
  return join(sessionHome(runtime), "bash-project-approvals.json");
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function bashProjectApprovalsError(message: string): never {
  throw new BashProjectApprovalsError(message);
}

function invalidFileMessage(filePath: string, result: z.ZodError): string {
  const message = result.issues
    .map((issue) => issue.message)
    .slice(0, 1)
    .join("");
  return `Error: cannot read bash project approvals ${filePath}: ${message}.`;
}

function readApprovalsFile(
  runtime: BashProjectApprovalRuntime,
): BashProjectApprovalsFile {
  const filePath = bashProjectApprovalsPath(runtime);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return { schemaVersion: 1, grants: [] };
    }
    bashProjectApprovalsError(
      `Error: cannot read bash project approvals ${filePath}: ${errorMessage(
        error,
      )}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    bashProjectApprovalsError(
      `Error: cannot read bash project approvals ${filePath}: invalid JSON.`,
    );
  }

  const result = bashProjectApprovalsFileSchema.safeParse(json);
  if (!result.success) {
    bashProjectApprovalsError(invalidFileMessage(filePath, result.error));
  }
  return result.data;
}

function writeApprovalsFile(
  runtime: BashProjectApprovalRuntime,
  file: BashProjectApprovalsFile,
): void {
  const filePath = bashProjectApprovalsPath(runtime);
  try {
    mkdirSync(sessionHome(runtime), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(filePath, 0o600);
  } catch (error) {
    bashProjectApprovalsError(
      `Error: cannot write bash project approvals ${filePath}: ${errorMessage(
        error,
      )}`,
    );
  }
}

function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

export function bashApprovalProjectRoot(workspace: string): string {
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

function copyGrant(grant: BashProjectApprovalGrant): BashProjectApprovalGrant {
  return {
    projectRoot: grant.projectRoot,
    cwd: grant.cwd,
    argvPrefix: [...grant.argvPrefix],
  };
}

function fileGrantFromGrant(
  grant: BashProjectApprovalGrant,
): BashProjectApprovalsFileGrant {
  return {
    projectRoot: grant.projectRoot,
    cwd: grant.cwd,
    argvPrefix: [...grant.argvPrefix],
  };
}

function grantKey(grant: BashProjectApprovalGrant): string {
  return JSON.stringify([grant.projectRoot, grant.argvPrefix]);
}

function grantsForProject(
  file: BashProjectApprovalsFile,
  projectRoot: string,
): readonly BashProjectApprovalGrant[] {
  return file.grants
    .filter((grant) => grant.projectRoot === projectRoot)
    .map(copyGrant);
}

export function listBashProjectApprovalGrants(
  runtime: BashProjectApprovalRuntime,
  projectRoot: string,
): readonly BashProjectApprovalGrant[] {
  return grantsForProject(readApprovalsFile(runtime), projectRoot);
}

export function saveBashProjectApprovalGrant(
  runtime: BashProjectApprovalRuntime,
  grant: BashProjectApprovalGrant,
): boolean {
  const file = readApprovalsFile(runtime);
  const key = grantKey(grant);
  if (file.grants.some((existing) => grantKey(existing) === key)) {
    return false;
  }
  writeApprovalsFile(runtime, {
    schemaVersion: 1,
    grants: [...file.grants, fileGrantFromGrant(grant)],
  });
  return true;
}

export function revokeBashProjectApprovalGrant(
  runtime: BashProjectApprovalRuntime,
  projectRoot: string,
  index: number,
): BashProjectApprovalGrant | null {
  const file = readApprovalsFile(runtime);
  const projectGrants = grantsForProject(file, projectRoot);
  const target = projectGrants[index - 1];
  if (target === undefined) {
    return null;
  }
  const targetKey = grantKey(target);
  writeApprovalsFile(runtime, {
    schemaVersion: 1,
    grants: file.grants.filter((grant) => grantKey(grant) !== targetKey),
  });
  return copyGrant(target);
}

export function clearBashProjectApprovalGrants(
  runtime: BashProjectApprovalRuntime,
  projectRoot: string,
): number {
  const file = readApprovalsFile(runtime);
  const remaining = file.grants.filter(
    (grant) => grant.projectRoot !== projectRoot,
  );
  const clearedCount = file.grants.length - remaining.length;
  if (clearedCount > 0) {
    writeApprovalsFile(runtime, {
      schemaVersion: 1,
      grants: remaining,
    });
  }
  return clearedCount;
}

export function formatBashProjectApprovalList(
  grants: readonly BashProjectApprovalGrant[],
): string {
  if (grants.length === 0) {
    return "No bash project approvals.\n";
  }

  const approvalLines: string[] = [];
  for (const [index, grant] of grants.entries()) {
    approvalLines.push(
      `  ${index + 1}. command family`,
      `     project: ${escapeApprovalText(grant.projectRoot)}`,
      `     approved from: ${escapeApprovalText(grant.cwd)}`,
      `     argv prefix: ${escapeApprovalText(grant.argvPrefix.join(" "))}`,
    );
  }

  return [
    "Bash project approvals:",
    ...approvalLines,
    "Use keel approvals revoke <index> or keel approvals clear to remove project approvals.",
    "",
  ].join("\n");
}

export function formatBashProjectApprovalRevoked(index: number): string {
  return `Revoked bash project approval ${index}.\n`;
}

export function formatBashProjectApprovalClearResult(count: number): string {
  if (count === 0) {
    return "No bash project approvals to clear.\n";
  }
  return count === 1
    ? "Cleared 1 bash project approval.\n"
    : `Cleared ${count} bash project approvals.\n`;
}
