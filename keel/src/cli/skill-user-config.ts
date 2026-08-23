import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import {
  ensurePrivateStateDirectory,
  PrivateStateError,
  privateStateDirectoryPath,
  privateStateRootPath,
} from "../core/private-state.ts";

interface SkillUserConfigRuntime {
  readonly env: (key: string) => string | undefined;
}

export interface UserSkillConfig {
  readonly enabled: boolean;
  readonly disabledPackageIds: readonly string[];
}

export type SkillRuntimePolicy =
  | (UserSkillConfig & { readonly enabled: true })
  | (UserSkillConfig & {
      readonly enabled: false;
      readonly unavailableReason: string;
    });

export interface SkillPolicyReport {
  readonly mode: "enabled" | "cli_disabled" | "globally_disabled" | "filtered";
  readonly disabledPackages: number;
}

export class SkillUserConfigError extends Error {}

const MAX_DISABLED_SKILL_PACKAGES = 10_000;
const SKILL_CONFIG_LOCK_WAIT_MS = 10;
const SKILL_CONFIG_LOCK_TIMEOUT_MS = 5_000;
const OWNERLESS_SKILL_CONFIG_LOCK_STALE_MS = 30_000;
const skillConfigLockOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    token: z.string().uuid(),
  })
  .strict();
const skillConfigFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    disabledPackageIds: z
      .array(z.string().min(1))
      .max(MAX_DISABLED_SKILL_PACKAGES)
      .refine((values) => new Set(values).size === values.length, {
        message: "disabledPackageIds must not contain duplicates",
      }),
  })
  .strict();

type SkillConfigFile = z.infer<typeof skillConfigFileSchema>;

const DEFAULT_USER_SKILL_CONFIG: UserSkillConfig = {
  enabled: true,
  disabledPackageIds: [],
};

function configError(message: string): never {
  throw new SkillUserConfigError(message);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function skillStateHome(
  runtime: SkillUserConfigRuntime,
  ensure = false,
): string {
  try {
    return ensure
      ? ensurePrivateStateDirectory(runtime, [], "KEEL_HOME")
      : privateStateDirectoryPath(runtime, [], "KEEL_HOME");
  } catch (error) {
    if (error instanceof PrivateStateError) {
      configError(error.message);
    }
    throw error;
  }
}

function userSkillConfigPath(runtime: SkillUserConfigRuntime): string {
  return join(privateStateRootPath(runtime), "skills.json");
}

function skillConfigLockPath(runtime: SkillUserConfigRuntime): string {
  return join(privateStateRootPath(runtime), "skills.lock");
}

function skillConfigLockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function reclaimedSkillConfigLockRoot(lockPath: string): string {
  return `${lockPath}.reclaimed`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasNodeErrorCode(error, "ESRCH");
  }
}

function readSkillConfigLockOwner(
  lockPath: string,
): z.infer<typeof skillConfigLockOwnerSchema> | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(skillConfigLockOwnerPath(lockPath), "utf8"),
    );
    const owner = skillConfigLockOwnerSchema.safeParse(parsed);
    return owner.success ? owner.data : null;
  } catch {
    return null;
  }
}

function staleSkillConfigLockGeneration(
  lockPath: string,
  owner: z.infer<typeof skillConfigLockOwnerSchema> | null,
): string | null {
  if (owner !== null) return owner.token;
  try {
    const stats = statSync(lockPath);
    return createHash("sha256")
      .update(`${stats.dev}:${stats.ino}:${stats.birthtimeMs}`)
      .digest("hex");
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return null;
    configError(
      `Error: cannot identify workflow skill config lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
}

function reclaimStaleSkillConfigLock(lockPath: string): boolean {
  const owner = readSkillConfigLockOwner(lockPath);
  if (owner !== null && processIsAlive(owner.pid)) return false;
  if (owner === null) {
    try {
      if (
        Date.now() - statSync(lockPath).mtimeMs <
        OWNERLESS_SKILL_CONFIG_LOCK_STALE_MS
      ) {
        return false;
      }
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) return true;
      configError(
        `Error: cannot inspect workflow skill config lock ${lockPath}: ${errorMessage(error)}`,
      );
    }
  }
  const generation = staleSkillConfigLockGeneration(lockPath, owner);
  if (generation === null) return true;
  const reclaimedRoot = reclaimedSkillConfigLockRoot(lockPath);
  const reclaimedPath = join(reclaimedRoot, generation);
  try {
    mkdirSync(reclaimedRoot, { recursive: true, mode: 0o700 });
    // Retain a non-empty tombstone for each generation so a delayed contender
    // cannot rename a replacement live lock over the same destination.
    writeFileSync(join(lockPath, ".reclaim-generation"), `${generation}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
    renameSync(lockPath, reclaimedPath);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return true;
    if (
      hasNodeErrorCode(error, "EEXIST") ||
      hasNodeErrorCode(error, "ENOTEMPTY")
    )
      return false;
    configError(
      `Error: cannot reclaim stale workflow skill config lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
}

function withUserSkillConfigLock<Result>(
  runtime: SkillUserConfigRuntime,
  action: () => Result,
): Result {
  const home = skillStateHome(runtime, true);
  const lockPath = skillConfigLockPath(runtime);
  const token = randomUUID();
  const deadline = Date.now() + SKILL_CONFIG_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (hasNodeErrorCode(error, "EEXIST")) {
        if (reclaimStaleSkillConfigLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          configError(
            `Error: workflow skill config ${userSkillConfigPath(runtime)} is busy; retry after the other Keel process finishes.`,
          );
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
          0,
          0,
          SKILL_CONFIG_LOCK_WAIT_MS,
        );
        continue;
      }
      configError(
        `Error: cannot acquire workflow skill config lock ${lockPath}: ${errorMessage(error)}`,
      );
    }
    try {
      writeFileSync(
        skillConfigLockOwnerPath(lockPath),
        `${JSON.stringify({ pid: process.pid, token })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      configError(
        `Error: cannot initialize workflow skill config lock ${lockPath}: ${errorMessage(error)}`,
      );
    }
    try {
      return action();
    } finally {
      const owner = readSkillConfigLockOwner(lockPath);
      if (owner?.token === token) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch (error) {
          configError(
            `Error: cannot release workflow skill config lock ${lockPath}: ${errorMessage(error)}`,
          );
        }
      }
    }
  }
}

function invalidConfigMessage(filePath: string, result: z.ZodError): string {
  const message = result.issues
    .slice(0, 1)
    .map((issue) => issue.message)
    .join("");
  return `Error: cannot read workflow skill config ${filePath}: ${message}.`;
}

export function readUserSkillConfig(
  runtime: SkillUserConfigRuntime,
): UserSkillConfig {
  const filePath = userSkillConfigPath(runtime);
  let content: string;
  try {
    skillStateHome(runtime);
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return DEFAULT_USER_SKILL_CONFIG;
    }
    configError(
      `Error: cannot read workflow skill config ${filePath}: ${errorMessage(error)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    configError(
      `Error: cannot read workflow skill config ${filePath}: invalid JSON.`,
    );
  }
  const parsed = skillConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    configError(invalidConfigMessage(filePath, parsed.error));
  }
  return {
    enabled: parsed.data.enabled,
    disabledPackageIds: [...parsed.data.disabledPackageIds],
  };
}

function configFile(config: UserSkillConfig): SkillConfigFile {
  return {
    schemaVersion: 1,
    enabled: config.enabled,
    disabledPackageIds: [...config.disabledPackageIds].toSorted(),
  };
}

function writeUserSkillConfig(
  runtime: SkillUserConfigRuntime,
  config: UserSkillConfig,
): void {
  const home = skillStateHome(runtime, true);
  const filePath = userSkillConfigPath(runtime);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(configFile(config), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    configError(
      `Error: cannot write workflow skill config ${filePath}: ${errorMessage(error)}`,
    );
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function setAllWorkflowSkillsEnabled(
  runtime: SkillUserConfigRuntime,
  enabled: boolean,
): UserSkillConfig {
  return withUserSkillConfigLock(runtime, () => {
    const next = enabled
      ? DEFAULT_USER_SKILL_CONFIG
      : {
          enabled: false,
          disabledPackageIds: readUserSkillConfig(runtime).disabledPackageIds,
        };
    writeUserSkillConfig(runtime, next);
    return next;
  });
}

export function setWorkflowSkillEnabled(
  runtime: SkillUserConfigRuntime,
  packageId: string,
  enabled: boolean,
): { readonly config: UserSkillConfig; readonly changed: boolean } {
  return withUserSkillConfigLock(runtime, () => {
    const current = readUserSkillConfig(runtime);
    const disabled = new Set(current.disabledPackageIds);
    const changed = enabled
      ? disabled.delete(packageId)
      : !disabled.has(packageId);
    if (!enabled) disabled.add(packageId);
    const next = {
      enabled: current.enabled,
      disabledPackageIds: [...disabled],
    };
    if (changed) writeUserSkillConfig(runtime, next);
    return { config: next, changed };
  });
}

export function resolveSkillRuntimePolicy(
  runtime: SkillUserConfigRuntime,
  cliSkillsEnabled: boolean,
): SkillRuntimePolicy {
  if (!cliSkillsEnabled) {
    return {
      enabled: false,
      disabledPackageIds: [],
      unavailableReason:
        "Error: workflow skills are disabled for this run by --no-skills.",
    };
  }
  const config = readUserSkillConfig(runtime);
  return config.enabled
    ? { ...config, enabled: true }
    : {
        ...config,
        enabled: false,
        unavailableReason:
          "Error: workflow skills are disabled by user configuration; run keel skills enable --all to enable them.",
      };
}

export function skillPolicyReport(
  policy: SkillRuntimePolicy,
  cliSkillsEnabled: boolean,
): SkillPolicyReport {
  const mode = !cliSkillsEnabled
    ? "cli_disabled"
    : !policy.enabled
      ? "globally_disabled"
      : policy.disabledPackageIds.length > 0
        ? "filtered"
        : "enabled";
  return { mode, disabledPackages: policy.disabledPackageIds.length };
}
