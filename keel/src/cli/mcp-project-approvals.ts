import { createHash, randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import type { McpAuthorizationIdentity } from "../mcp/oauth.ts";
import type { McpPermissionRequest } from "../mcp/runtime-types.ts";
import type { ToolJsonValue } from "../tools/tool-call.ts";
import { escapeApprovalText } from "./bash-approval-text.ts";
import { sessionHome } from "./session-store.ts";

const MCP_PROJECT_APPROVALS_SCHEMA_VERSION = 1;
const MCP_PROJECT_APPROVALS_MAX_BYTES = 1024 * 1024;
const MCP_PROJECT_APPROVALS_MAX_GRANTS = 1_024;
const MCP_PROJECT_APPROVALS_LOCK_TIMEOUT_MS = 5_000;
const MCP_PROJECT_APPROVALS_STALE_LOCK_MS = 30_000;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const authorizationIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anonymous") }).strict(),
  z
    .object({
      kind: z.literal("oauth"),
      issuer: z.string().url(),
      clientId: z.string().min(1).max(4_096),
      grantId: z.uuid(),
    })
    .strict(),
]);
const mcpProjectApprovalGrantSchema = z
  .object({
    projectRoot: z.string().min(1),
    serverId: z.string().min(1).max(64),
    origin: z.string().url(),
    configurationDigest: sha256Schema,
    rawToolName: z.string().min(1).max(128),
    descriptorDigest: sha256Schema,
    authorizationIdentity: authorizationIdentitySchema,
    argumentsDigest: sha256Schema,
  })
  .strict();
const mcpProjectApprovalsFileSchema = z
  .object({
    schemaVersion: z.literal(MCP_PROJECT_APPROVALS_SCHEMA_VERSION),
    grants: z
      .array(mcpProjectApprovalGrantSchema)
      .max(MCP_PROJECT_APPROVALS_MAX_GRANTS),
  })
  .strict();

export type McpProjectApprovalGrant = z.infer<
  typeof mcpProjectApprovalGrantSchema
>;
type McpProjectApprovalsFile = z.infer<typeof mcpProjectApprovalsFileSchema>;

interface McpProjectApprovalRuntime {
  readonly env: (key: string) => string | undefined;
}

export class McpProjectApprovalsError extends Error {}

function approvalsPath(runtime: McpProjectApprovalRuntime): string {
  return join(sessionHome(runtime), "mcp-project-approvals.json");
}

function approvalsLockPath(runtime: McpProjectApprovalRuntime): string {
  return join(sessionHome(runtime), ".mcp-project-approvals.lock");
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function approvalError(message: string): never {
  throw new McpProjectApprovalsError(message);
}

function canonicalJson(value: ToolJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function argumentsDigest(
  value: Readonly<Record<string, ToolJsonValue>>,
): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function copyAuthorizationIdentity(
  identity: McpAuthorizationIdentity,
): McpAuthorizationIdentity {
  return identity.kind === "anonymous"
    ? { kind: "anonymous" }
    : {
        kind: "oauth",
        issuer: identity.issuer,
        clientId: identity.clientId,
        grantId: identity.grantId,
      };
}

function copyGrant(grant: McpProjectApprovalGrant): McpProjectApprovalGrant {
  return {
    projectRoot: grant.projectRoot,
    serverId: grant.serverId,
    origin: grant.origin,
    configurationDigest: grant.configurationDigest,
    rawToolName: grant.rawToolName,
    descriptorDigest: grant.descriptorDigest,
    authorizationIdentity: copyAuthorizationIdentity(
      grant.authorizationIdentity,
    ),
    argumentsDigest: grant.argumentsDigest,
  };
}

export function mcpProjectApprovalGrant(
  projectRoot: string,
  request: McpPermissionRequest,
): McpProjectApprovalGrant {
  return {
    projectRoot,
    serverId: request.serverId,
    origin: request.origin,
    configurationDigest: request.configurationDigest,
    rawToolName: request.rawToolName,
    descriptorDigest: request.descriptorDigest,
    authorizationIdentity: copyAuthorizationIdentity(
      request.authorizationIdentity,
    ),
    argumentsDigest: argumentsDigest(request.arguments),
  };
}

function grantKey(grant: McpProjectApprovalGrant): string {
  return JSON.stringify(grant);
}

function grantsForProject(
  file: McpProjectApprovalsFile,
  projectRoot: string,
): readonly McpProjectApprovalGrant[] {
  return file.grants
    .filter((grant) => grant.projectRoot === projectRoot)
    .map(copyGrant);
}

async function readApprovalsFile(
  runtime: McpProjectApprovalRuntime,
): Promise<McpProjectApprovalsFile> {
  const filePath = approvalsPath(runtime);
  let fileSize: number;
  try {
    fileSize = (await stat(filePath)).size;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return {
        schemaVersion: MCP_PROJECT_APPROVALS_SCHEMA_VERSION,
        grants: [],
      };
    }
    /* v8 ignore next 3 -- requires an injected stat fault other than missing/oversized; ordinary malformed states continue through bounded read and schema validation. */
    approvalError(
      `Error: cannot inspect MCP project approvals ${filePath}: ${errorMessage(error)}.`,
    );
  }
  if (fileSize > MCP_PROJECT_APPROVALS_MAX_BYTES) {
    approvalError(
      `Error: cannot read MCP project approvals ${filePath}: file exceeds ${MCP_PROJECT_APPROVALS_MAX_BYTES} bytes.`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    approvalError(
      `Error: cannot read MCP project approvals ${filePath}: ${errorMessage(error)}.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    approvalError(
      `Error: cannot read MCP project approvals ${filePath}: invalid JSON.`,
    );
  }
  const parsed = mcpProjectApprovalsFileSchema.safeParse(json);
  if (!parsed.success) {
    approvalError(
      `Error: cannot read MCP project approvals ${filePath}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}.`,
    );
  }
  return parsed.data;
}

async function syncDirectory(directory: string): Promise<void> {
  /* v8 ignore next -- Windows cannot fsync a directory handle. */
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeApprovalsFile(
  runtime: McpProjectApprovalRuntime,
  file: McpProjectApprovalsFile,
): Promise<void> {
  const home = sessionHome(runtime);
  const filePath = approvalsPath(runtime);
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MCP_PROJECT_APPROVALS_MAX_BYTES) {
    approvalError(
      `Error: cannot write MCP project approvals ${filePath}: file would exceed ${MCP_PROJECT_APPROVALS_MAX_BYTES} bytes.`,
    );
  }
  const tempPath = join(
    home,
    `.mcp-project-approvals.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);
    await syncDirectory(home);
  } catch (error) {
    /* v8 ignore start -- publication faults require OS/filesystem failure injection; cleanup is best effort. */
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Preserve the publication failure.
    }
    approvalError(
      `Error: cannot write MCP project approvals ${filePath}: ${errorMessage(error)}.`,
    );
    /* v8 ignore stop */
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs <= MCP_PROJECT_APPROVALS_STALE_LOCK_MS) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } catch (error) {
    /* v8 ignore next -- another process may remove the lock between open and stat. */
    if (hasNodeErrorCode(error, "ENOENT")) return true;
    /* v8 ignore next 3 -- requires an injected stat/removal fault; live and stale lock behavior is covered with the real filesystem. */
    approvalError(
      `Error: cannot inspect MCP project approval lock ${lockPath}: ${errorMessage(error)}.`,
    );
  }
}

async function acquireApprovalsLock(
  runtime: McpProjectApprovalRuntime,
): Promise<FileHandle> {
  const lockPath = approvalsLockPath(runtime);
  const deadline = Date.now() + MCP_PROJECT_APPROVALS_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      /* v8 ignore next 4 -- non-contention open faults need OS failure injection. */
      if (!hasNodeErrorCode(error, "EEXIST")) {
        approvalError(
          `Error: cannot lock MCP project approvals ${lockPath}: ${errorMessage(error)}.`,
        );
      }
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        approvalError(`Error: MCP project approvals are busy: ${lockPath}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function withApprovalsLock<Result>(
  runtime: McpProjectApprovalRuntime,
  action: () => Promise<Result>,
): Promise<Result> {
  const home = sessionHome(runtime);
  const lockPath = approvalsLockPath(runtime);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const handle = await acquireApprovalsLock(runtime);
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function hasMcpProjectApprovalGrant(
  runtime: McpProjectApprovalRuntime,
  grant: McpProjectApprovalGrant,
): Promise<boolean> {
  return await withApprovalsLock(runtime, async () => {
    const key = grantKey(grant);
    return (await readApprovalsFile(runtime)).grants.some(
      (existing) => grantKey(existing) === key,
    );
  });
}

export async function saveMcpProjectApprovalGrant(
  runtime: McpProjectApprovalRuntime,
  grant: McpProjectApprovalGrant,
): Promise<boolean> {
  return await withApprovalsLock(runtime, async () => {
    const file = await readApprovalsFile(runtime);
    const key = grantKey(grant);
    if (file.grants.some((existing) => grantKey(existing) === key)) {
      return false;
    }
    if (file.grants.length >= MCP_PROJECT_APPROVALS_MAX_GRANTS) {
      approvalError(
        `Error: MCP project approvals support at most ${MCP_PROJECT_APPROVALS_MAX_GRANTS} grants.`,
      );
    }
    await writeApprovalsFile(runtime, {
      schemaVersion: MCP_PROJECT_APPROVALS_SCHEMA_VERSION,
      grants: [...file.grants, copyGrant(grant)],
    });
    return true;
  });
}

export async function listMcpProjectApprovalGrants(
  runtime: McpProjectApprovalRuntime,
  projectRoot: string,
): Promise<readonly McpProjectApprovalGrant[]> {
  return await withApprovalsLock(runtime, async () =>
    grantsForProject(await readApprovalsFile(runtime), projectRoot),
  );
}

export async function revokeMcpProjectApprovalGrant(
  runtime: McpProjectApprovalRuntime,
  projectRoot: string,
  index: number,
): Promise<McpProjectApprovalGrant | null> {
  return await withApprovalsLock(runtime, async () => {
    const file = await readApprovalsFile(runtime);
    const target = grantsForProject(file, projectRoot)[index - 1];
    if (target === undefined) return null;
    const targetKey = grantKey(target);
    await writeApprovalsFile(runtime, {
      schemaVersion: MCP_PROJECT_APPROVALS_SCHEMA_VERSION,
      grants: file.grants.filter((grant) => grantKey(grant) !== targetKey),
    });
    return copyGrant(target);
  });
}

export async function clearMcpProjectApprovalGrants(
  runtime: McpProjectApprovalRuntime,
  projectRoot: string,
): Promise<number> {
  return await withApprovalsLock(runtime, async () => {
    const file = await readApprovalsFile(runtime);
    const remaining = file.grants.filter(
      (grant) => grant.projectRoot !== projectRoot,
    );
    const count = file.grants.length - remaining.length;
    if (count > 0) {
      await writeApprovalsFile(runtime, {
        schemaVersion: MCP_PROJECT_APPROVALS_SCHEMA_VERSION,
        grants: remaining,
      });
    }
    return count;
  });
}

function formatAuthorizationIdentity(
  identity: McpAuthorizationIdentity,
): readonly string[] {
  return identity.kind === "anonymous"
    ? ["     authorization: anonymous"]
    : [
        `     authorization issuer: ${escapeApprovalText(identity.issuer)}`,
        `     OAuth client: ${escapeApprovalText(identity.clientId)}`,
        `     authorization grant: ${escapeApprovalText(identity.grantId)}`,
      ];
}

export function formatMcpProjectApprovalList(
  grants: readonly McpProjectApprovalGrant[],
): string {
  if (grants.length === 0) {
    return "No MCP project approvals.\n";
  }
  const lines: string[] = [];
  for (const [index, grant] of grants.entries()) {
    lines.push(
      `  ${index + 1}. exact MCP call`,
      `     project: ${escapeApprovalText(grant.projectRoot)}`,
      `     origin: ${escapeApprovalText(grant.origin)}`,
      `     tool: ${escapeApprovalText(`${grant.serverId}/${grant.rawToolName}`)}`,
      ...formatAuthorizationIdentity(grant.authorizationIdentity),
      `     configuration: sha256:${grant.configurationDigest}`,
      `     descriptor: sha256:${grant.descriptorDigest}`,
      `     arguments: sha256:${grant.argumentsDigest}`,
    );
  }
  return [
    "MCP project approvals:",
    ...lines,
    "Use keel mcp approvals revoke <index> or keel mcp approvals clear to remove project approvals.",
    "",
  ].join("\n");
}

export function formatMcpProjectApprovalRevoked(index: number): string {
  return `Revoked MCP project approval ${index}.\n`;
}

export function formatMcpProjectApprovalClearResult(count: number): string {
  if (count === 0) return "No MCP project approvals to clear.\n";
  return count === 1
    ? "Cleared 1 MCP project approval.\n"
    : `Cleared ${count} MCP project approvals.\n`;
}
