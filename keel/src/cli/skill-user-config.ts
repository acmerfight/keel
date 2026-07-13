import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import { sessionHome } from "./session-store.ts";

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

function userSkillConfigPath(runtime: SkillUserConfigRuntime): string {
  return join(sessionHome(runtime), "skills.json");
}

function invalidConfigMessage(filePath: string, result: z.ZodError): string {
  const issue = result.issues[0];
  /* v8 ignore next -- Zod schema failures always contain an issue. */
  const message = issue?.message ?? "invalid schema";
  return `Error: cannot read workflow skill config ${filePath}: ${message}.`;
}

export function readUserSkillConfig(
  runtime: SkillUserConfigRuntime,
): UserSkillConfig {
  const filePath = userSkillConfigPath(runtime);
  let content: string;
  try {
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
  const home = sessionHome(runtime);
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
  const next = enabled
    ? DEFAULT_USER_SKILL_CONFIG
    : {
        enabled: false,
        disabledPackageIds: readUserSkillConfig(runtime).disabledPackageIds,
      };
  writeUserSkillConfig(runtime, next);
  return next;
}

export function setWorkflowSkillEnabled(
  runtime: SkillUserConfigRuntime,
  packageId: string,
  enabled: boolean,
): { readonly config: UserSkillConfig; readonly changed: boolean } {
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
